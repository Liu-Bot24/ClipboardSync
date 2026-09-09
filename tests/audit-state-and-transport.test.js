import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import WebSocket from 'ws';
import { HistoryRefreshController, SingleFlightSampler } from '../src/client/async-state.js';
import { HubClient } from '../src/client/hub-client.js';
import { ConfigStore } from '../src/client/config-store.js';
import { MacLocalProxy } from '../src/client/mac-local-proxy.js';
import { EventStore } from '../src/event-store.js';
import { createClipboardHubServer, sendSocketJson } from '../src/server.js';
import { assertImageBudget } from '../src/client/image-limits.js';
import { ClipboardSnapshotReader } from '../src/client/clipboard-reader.js';
import { readWindowsClipboardSource } from '../src/client/clipboard-source.js';
import { pasteIntoWindowsTarget } from '../src/client/direct-paste.js';
import { ClipboardSyncService } from '../src/client/sync-service.js';
import { ClipboardLoopGuard } from '../src/client/loop-guard.js';
import { textSnapshot } from '../src/client/clipboard-content.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-audit-state-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return dir;
}

test('concurrent copies converge over real Hub connections without rebroadcasting', { timeout: 5000 }, async (t) => {
  const server = await createClipboardHubServer({ host: '127.0.0.1', port: 0, historyPath: join(await directory(t), 'history.jsonl') });
  await server.listen();
  const peers = [];
  t.after(async () => { for (const peer of peers) { peer.service.stop(); peer.hub.stop(); } await server.close(); });
  for (const deviceId of ['A', 'B']) {
    const settings = { deviceId, deviceName: deviceId, hubUrl: `http://127.0.0.1:${server.address().port}` };
    const hub = new HubClient(() => settings);
    const peer = { hub, snapshot: textSnapshot('baseline'), received: [] };
    peer.service = new ClipboardSyncService({
      hub, settingsProvider: () => settings, devicesProvider: () => [], loopGuard: new ClipboardLoopGuard(),
      pollMs: 60_000,
      clipboard: { readSnapshot: () => peer.snapshot, writeEvent: (event) => { peer.snapshot = textSnapshot(event.content); } }
    });
    peers.push(peer);
    peer.service.start();
    hub.on('clipboard', (event) => peer.received.push(event));
    const connected = new Promise((resolve) => hub.on('status', (status) => { if (status.state === 'connected') resolve(); }));
    hub.start(); await connected;
  }
  const acknowledged = peers.map((peer) => once(peer.hub, 'ack'));
  for (const [index, peer] of peers.entries()) { peer.snapshot = textSnapshot(index ? 'B' : 'A'); peer.service.pollLocalClipboard(); }
  await Promise.all(acknowledged);
  // Acknowledgements and updates use the same ordered WebSocket stream; allow
  // the other peer's final update to reach its callback as well.
  const deadline = Date.now() + 2000;
  while (peers.some((peer) => peer.received.length < 2) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  for (const peer of peers) {
    assert.equal(peer.received.length, 2);
    assert.equal(peer.snapshot.content, peer.received.at(-1).content);
    peer.service.pollLocalClipboard();
    assert.equal(peer.service.pendingLocalHashes.size, 0);
  }
  assert.equal(peers[0].snapshot.content, peers[1].snapshot.content);
});

for (const reason of ['live event', 'clear', 'Hub change']) test(`audit: stale HTTP history cannot overwrite ${reason}`, async () => {
  const gate = new HistoryRefreshController();
  const slow = deferred(); let history = ['old'];
  const refresh = gate.refresh(() => slow.promise, (events) => { history = events; });
  gate.invalidate(); history = reason === 'live event' ? ['new'] : [];
  slow.resolve(['stale']); assert.equal(await refresh, false);
  assert.deepEqual(history, reason === 'live event' ? ['new'] : []);
  assert.equal(await gate.refresh(async () => ['fresh'], (events) => { history = events; }), true);
  assert.deepEqual(history, ['fresh']);
});

test('audit: only the latest concurrent history refresh is applied', async () => {
  const gate = new HistoryRefreshController(); const slow = deferred(); const applied = [];
  const first = gate.refresh(() => slow.promise, (v) => applied.push(v));
  await gate.refresh(async () => 'latest', (v) => applied.push(v)); slow.resolve('old');
  assert.equal(await first, false); assert.deepEqual(applied, ['latest']);
});

test('audit: target sampling does not overlap and invalidation drops old results', async () => {
  const sampler = new SingleFlightSampler(); const slow = deferred(); let reads = 0; const applied = [];
  const read = () => { reads++; return slow.promise; }; const apply = (v) => { applied.push(v); return v; };
  const a = sampler.sample(read, apply); const b = sampler.sample(read, apply);
  await Promise.resolve(); assert.equal(reads, 1); assert.equal(a, b);
  sampler.invalidate(); slow.resolve('stale'); assert.equal(await a, null); assert.deepEqual(applied, []);
  assert.equal(await sampler.sample(async () => 'fresh', apply), 'fresh'); assert.deepEqual(applied, ['fresh']);
});

class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.messages = []; }
  close() { queueMicrotask(() => this.emit('error', new Error('closed while connecting'))); }
  send(message) { this.messages.push(JSON.parse(message)); }
}
const settings = () => ({ hubUrl: 'http://127.0.0.1:8787', deviceId: 'local', deviceName: 'Local' });
test('audit: reconnect preserves an error boundary and ignores old socket business events', async () => {
  const hub = new HubClient(settings, { WebSocketImpl: FakeSocket }); const clipboard = []; const states = [];
  hub.on('clipboard', (event) => clipboard.push(event)); hub.on('status', (state) => states.push(state));
  hub.start(); const old = hub.ws; hub.reconnectNow(); const current = hub.ws;
  old.emit('message', Buffer.from(JSON.stringify({ type: 'clipboard.update', id: 'obsolete' })));
  old.emit('close', 1006); await Promise.resolve();
  assert.equal(hub.ws, current); assert.deepEqual(clipboard, []); assert.deepEqual(states, []);
  hub.stop(); await Promise.resolve();
});
test('audit: ACK and old unpersisted echoes cannot enter clipboard history', () => {
  const hub = new HubClient(settings, { WebSocketImpl: FakeSocket }); const history = []; const acks = [];
  hub.on('clipboard', (e) => history.push(e)); hub.on('ack', (e) => acks.push(e)); hub.start();
  for (const event of [{ type: 'clipboard.ack', clientEventId: 'one' }, { type: 'clipboard.update', sourceDeviceId: 'local' }, { type: 'clipboard.update', id: 'stored' }]) {
    hub.ws.emit('message', Buffer.from(JSON.stringify(event)));
  }
  assert.equal(acks.length, 2); assert.deepEqual(history.map((e) => e.id), ['stored']); hub.stop();
});
test('audit: a REST response from a retired Hub cannot publish configuration', async () => {
  const slow = deferred(); const configurations = [];
  const hub = new HubClient(settings, { fetchImpl: () => slow.promise });
  hub.on('config', (value) => configurations.push(value)); const request = hub.refreshConfig();
  hub.stop(); slow.resolve({ ok: true, json: async () => ({ historyDisplayLimit: 999 }) });
  await assert.rejects(request, { name: 'AbortError' }); assert.deepEqual(configurations, []);
});

test('audit: concurrent config updates leave one complete latest snapshot on disk', async (t) => {
  const dir = await directory(t); const store = new ConfigStore(null, { path: join(dir, 'config.json'), env: {} });
  await store.load();
  await Promise.all(Array.from({ length: 40 }, (_, n) => store.update({ deviceName: `device-${n}`, pauseSend: n % 2 === 1 })));
  assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), store.get());
  assert.equal(store.get().deviceName, 'device-39');
  await mkdir(`${store.path}.tmp`);
  await assert.rejects(store.update({ deviceName: 'unsaved' }));
  assert.equal(JSON.parse(await readFile(store.path, 'utf8')).deviceName, 'device-39');
  await rm(`${store.path}.tmp`, { recursive: true });
  await store.update({ deviceName: 'recovered' });
  assert.equal(JSON.parse(await readFile(store.path, 'utf8')).deviceName, 'recovered');
});

function fakeProxy() {
  const children = [];
  const proxy = new MacLocalProxy({ executablePath: 'proxy', configPath: 'config', existsSyncImpl: () => true,
    mkdirImpl: async () => {}, writeFileImpl: async () => {}, spawnImpl: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.exitCode = null;
      child.kill = () => { child.killed = true; queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); }); };
      children.push(child);
      setImmediate(() => child.stdout.emit('data', Buffer.from('clipboard local proxy listening on 127.0.0.1:18787')));
      return child;
    } });
  return { proxy, children };
}
test('audit: old proxy exit cannot discard the replacement and stop kills its owner', async () => {
  const { proxy, children } = fakeProxy();
  await proxy.ensureForHubUrl('http://192.0.2.1'); await proxy.ensureForHubUrl('http://192.0.2.2');
  children[0].emit('exit', 0); assert.equal(proxy.child, children[1]); assert.equal(proxy.isActive(), true);
  await proxy.stop(); assert.equal(children[1].killed, true); assert.equal(proxy.isActive(), false);
});
test('audit: latest proxy request wins a concurrent Hub switch', async () => {
  const { proxy } = fakeProxy();
  const first = proxy.ensureForHubUrl('http://192.0.2.1'); const second = proxy.ensureForHubUrl('http://192.0.2.2');
  assert.equal(await first, false); assert.equal(await second, true); assert.equal(proxy.targetUrl, 'http://192.0.2.2');
  await proxy.stop();
});

test('audit: queue admission is bounded before appends can accumulate', async (t) => {
  const store = new EventStore(join(await directory(t), 'history.jsonl'), { maxQueuedEntries: 1 }); await store.ready();
  const gate = deferred(); store.appendQueue = gate.promise;
  const event = { type: 'clipboard.update', contentType: 'text/plain', content: 'one', encoding: 'utf8', sourceDeviceId: 'A', sha256: 'one' };
  const accepted = store.append(event);
  await assert.rejects(store.append({ ...event, content: 'two' }), /queue is full/);
  gate.resolve(); await accepted; assert.equal(store.queuedEntries, 0); assert.equal(store.queuedBytes, 0);
});
test('audit: slow socket cannot accumulate an unbounded outbound buffer', () => {
  let terminated = false; let sent = false;
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 100, terminate() { terminated = true; }, send() { sent = true; } };
  assert.equal(sendSocketJson(ws, { type: 'test' }, 100), false); assert.equal(terminated, true); assert.equal(sent, false);
  ws.bufferedAmount = 0; assert.equal(sendSocketJson(ws, { type: 'test' }, 100), true); assert.equal(sent, true);
});

test('audit: malformed HTTP Host and invalid WebSocket frames cannot kill the Hub', async (t) => {
  const server = await createClipboardHubServer({ host: '127.0.0.1', port: 0, historyPath: join(await directory(t), 'history.jsonl') });
  await server.listen(); t.after(() => server.close()); const port = server.address().port;
  const raw = net.connect(port, '127.0.0.1'); let response = ''; raw.on('data', (data) => { response += data; });
  raw.write('GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n'); await once(raw, 'close');
  assert.match(response, /200 OK/);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?deviceId=bad`); await once(ws, 'open');
  const closed = once(ws, 'close'); ws._socket.write(Buffer.from([0x81, 0x01, 0x61])); // unmasked client frame
  await closed;
  const health = await fetch(`http://127.0.0.1:${port}/health`); assert.equal(health.status, 200);
});

test('audit: image dimensions are checked before native decoding', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP8z8AARQAFAAHeAitJAAAAAElFTkSuQmCC', 'base64');
  assert.equal(assertImageBudget(png, 'image/png').width, 1);
  const oversized = Buffer.from(png); oversized.writeUInt32BE(100_000, 16);
  assert.throws(() => assertImageBudget(oversized, 'image/png'), /pixel budget/);
  assert.throws(() => assertImageBudget(png, 'image/jpeg'), /format/);
});
test('audit: unchanged pixels reuse PNG encoding without hiding a subsequent image', () => {
  let pixel = 1; let encoded = 0;
  const reader = new ClipboardSnapshotReader();
  const clipboard = { availableFormats: () => ['image/png'], readImage: () => ({
    isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.from([pixel, 0, 0, 255]),
    toPNG: () => { encoded++; return Buffer.from([pixel]); }
  }) };
  const first = reader.read(clipboard); assert.equal(reader.read(clipboard), first); assert.equal(encoded, 1);
  pixel = 2; assert.notEqual(reader.read(clipboard).hash, first.hash); assert.equal(encoded, 2);
});
test('audit: source query has a bounded lifetime and Windows paste checks the final foreground target', async () => {
  let sourceOptions;
  await readWindowsClipboardSource({ execFileImpl: (_file, _args, options, callback) => { sourceOptions = options; callback(null, '{}'); } });
  assert.equal(sourceOptions.windowsHide, true); assert.ok(sourceOptions.timeout > 0 && sourceOptions.timeout <= 4000);
  let script;
  assert.equal(await pasteIntoWindowsTarget({ hwnd: 123, pid: 456 }, { ownPid: 1, execFileImpl: (_f, args, _o, cb) => { script = args.at(-1); cb(new Error('foreground mismatch')); } }), false);
  assert.ok(script.indexOf('$foreground -ne $hwnd') < script.indexOf("SendWait('^v')"));
  assert.match(script, /\$targetProcessId -ne 456/);
});
