import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryRefreshController } from '../src/client/async-state.js';
import { EventStore } from '../src/event-store.js';
import { HubClient } from '../src/client/hub-client.js';
import { createClipboardHubServer } from '../src/server.js';
import { assertImageBudget } from '../src/client/image-limits.js';
import WebSocket from 'ws';
import { receiverPolicyFromSettings } from '../src/receive-policy.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

for (const initiallyAllowed of [false, true]) test(`T2: real control limit recovers latest policy, initially allowed=${initiallyAllowed}`, { timeout: 10000 }, async (t) => {
  const server = await createClipboardHubServer({ host: '127.0.0.1', port: 0, historyPath: join(await directory(t), 'history.jsonl') });
  await server.listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let settings = { hubUrl: baseUrl, deviceId: 'receiver', deviceRules: { sender: { receive: initiallyAllowed } } };
  const hub = new HubClient(() => settings);
  const sender = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/v1/ws?deviceId=sender`);
  t.after(async () => { sender.terminate(); hub.stop(); await server.close(); });
  await new Promise((resolve, reject) => { sender.once('open', resolve); sender.once('error', reject); });
  const connected = new Promise((resolve) => hub.on('status', (state) => { if (state.state === 'connected') resolve(); }));
  hub.start(); await connected;
  const socket = hub.ws;
  const limited = () => new Promise((resolve) => {
    const listener = (data) => { if (JSON.parse(data).code === 'control-rate-limited') { socket.off('message', listener); resolve(); } };
    socket.on('message', listener);
  });
  const exhausted = limited();
  for (let i = 0; i < 8; i++) socket.send(JSON.stringify({ type: 'client.receiver-policy', policy: receiverPolicyFromSettings(settings), policyRevision: 5000 + i }));
  await exhausted;
  const rejected = limited();
  settings = { ...settings, deviceRules: { sender: { receive: !initiallyAllowed } } };
  const confirmed = new Promise((resolve) => hub.once('receiver-policy-updated', resolve));
  hub.sendReceiverPolicy(); await rejected; await confirmed;
  assert.equal(hub.ws, socket, 'recovery should not require reconnecting');
  const committed = new Promise((resolve) => sender.on('message', (data) => { if (JSON.parse(data).type === 'clipboard.update') resolve(); }));
  const live = []; hub.on('clipboard', (event) => live.push(event));
  sender.send(JSON.stringify({ type: 'clipboard.update', contentType: 'text/plain', encoding: 'utf8', content: 'after policy recovery' }));
  await committed;
  const history = await hub.fetchHistory();
  assert.equal(history.length, initiallyAllowed ? 0 : 1);
  if (!initiallyAllowed) {
    const deadline = Date.now() + 1000;
    while (!live.length && Date.now() < deadline) await pause(5);
  }
  assert.equal(live.length, initiallyAllowed ? 0 : 1);
});
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-audit-r2-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('S3: a live event invalidating initial history schedules one full follow-up refresh', async (t) => {
  const gate = new HistoryRefreshController({ retryDelayMs: 5 }); t.after(() => gate.setEnabled?.(false));
  const first = deferred(); let loads = 0; let history = [];
  const pending = gate.refresh(() => { loads++; return loads === 1 ? first.promise : Promise.resolve(['H1', 'H2', 'H3']); },
    (events) => { history = events; }, { retryOnStale: true });
  gate.invalidate(); history = ['H3']; first.resolve(['H1', 'H2']); await pending;
  await pause(40);
  assert.deepEqual(history, ['H1', 'H2', 'H3']); assert.equal(loads, 2);
});

test('S3: background refresh coalesces requests and stops retrying when its connection retires', async () => {
  const gate = new HistoryRefreshController({ retryDelayMs: 5 }); const delayed = deferred();
  let loads = 0; const applied = [];
  const load = () => { loads++; return delayed.promise; };
  const requests = Array.from({ length: 20 }, () => gate.refresh(load, (value) => applied.push(value), { retryOnStale: true }));
  assert.equal(loads, 1); gate.setEnabled(false); delayed.resolve(['stale']); await Promise.all(requests); await pause(15);
  assert.equal(loads, 1); assert.deepEqual(applied, []);
  gate.setEnabled(true); await gate.refresh(async () => ['new'], (value) => applied.push(value), { retryOnStale: true });
  assert.deepEqual(applied, [['new']]); gate.setEnabled(false);
});

for (const ending of ['LF', 'no-LF', 'corrupt-tail', 'CRLF']) test(`S5: ${ending} history survives append and restart`, async (t) => {
  const path = join(await directory(t), 'history.jsonl');
  const input = { type: 'clipboard.update', sourceDeviceId: 'local', contentType: 'text/plain', encoding: 'utf8', content: 'old', sha256: 'old', byteLength: 3 };
  const initial = new EventStore(path); await initial.ready(); const old = await initial.append(input);
  const json = JSON.stringify(old);
  await writeFile(path, ending === 'no-LF' ? json : ending === 'corrupt-tail' ? `${json}\n{broken` : ending === 'CRLF' ? `${json}\r\n` : `${json}\n`);
  const store = new EventStore(path); await store.ready();
  const trackedBytes = store.fileBytes; const actualBytes = (await stat(path)).size;
  await store.append({ ...input, content: 'new', sha256: 'new' });
  const restarted = new EventStore(path); await restarted.ready();
  assert.deepEqual(restarted.recent().map((e) => e.content), ['old', 'new']);
  assert.equal(trackedBytes, actualBytes);
  assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 2);
});

test('Q7: a declared WebP cannot fall through to the SVG parser', () => {
  assert.throws(() => assertImageBudget(Buffer.from('RIFF0000WEBP<svg width="1" height="1"></svg>'), 'image/webp'));
});

test('S7: a rejected initial policy retries on the same connection and completes readiness', async () => {
  class Socket extends EventEmitter {
    constructor() { super(); this.OPEN = 1; this.readyState = 1; this.messages = []; }
    send(message) {
      this.messages.push(JSON.parse(message));
      if (this.messages.length === 1) queueMicrotask(() => this.emit('message', Buffer.from('{"type":"error","message":"queue full"}')));
      else queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'hub.receiver-policy-updated', policyRevision: this.messages.at(-1).policyRevision }))));
    }
    close() {}
  }
  const hub = new HubClient(() => ({ hubUrl: 'http://127.0.0.1:8787', deviceId: 'local', deviceName: 'Local' }), {
    WebSocketImpl: Socket, policyAckMs: 5, fetchImpl: async () => ({ ok: true, json: async () => ({ devices: [], historyDisplayLimit: 30 }) })
  });
  try {
    hub.start(); const socket = hub.ws;
    socket.emit('message', Buffer.from('{"type":"hub.config","receiverPolicyRevision":true}'));
    socket.emit('open'); await pause(40);
    assert.equal(hub.receiverPolicyReady, true); assert.equal(hub.ws, socket); assert.equal(socket.messages.length, 2);
  } finally { hub.stop(); }
});

test('S7: exhausted business capacity does not block control-plane initialization', async (t) => {
  const server = await createClipboardHubServer({ host: '127.0.0.1', port: 0, historyPath: join(await directory(t), 'history.jsonl'), maxQueuedEntries: 0 });
  await server.listen(); t.after(() => server.close());
  const hub = new HubClient(() => ({ hubUrl: `http://127.0.0.1:${server.address().port}`, deviceId: 'joining', deviceName: 'Joining' }), { policyAckMs: 10 });
  t.after(() => hub.stop()); hub.start();
  for (let i = 0; i < 30 && !hub.receiverPolicyReady; i++) await pause(10);
  assert.equal(hub.receiverPolicyReady, true);
});

test('S7: a real blocked store queue leaves receive-policy initialization and filtering available', async (t) => {
  const blocked = deferred(); const entered = deferred();
  const appendNow = EventStore.prototype.appendNow;
  t.mock.method(EventStore.prototype, 'appendNow', async function(event) {
    entered.resolve(); await blocked.promise; return appendNow.call(this, event);
  });
  const server = await createClipboardHubServer({ host: '127.0.0.1', port: 0, historyPath: join(await directory(t), 'history.jsonl'), maxQueuedEntries: 1 });
  await server.listen(); t.after(async () => { blocked.resolve(); await server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sender = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/v1/ws?deviceId=sender`);
  t.after(() => sender.terminate());
  await new Promise((resolve, reject) => { sender.once('open', resolve); sender.once('error', reject); });
  const stored = new Promise((resolve) => sender.on('message', (data) => {
    const event = JSON.parse(data.toString()); if (event.type === 'clipboard.update') resolve(event);
  }));
  sender.send(JSON.stringify({ type: 'clipboard.update', contentType: 'text/plain', encoding: 'utf8', content: 'blocked disk write' }));
  await entered.promise;
  const hub = new HubClient(() => ({ hubUrl: baseUrl, deviceId: 'joining', deviceName: 'Joining', deviceRules: { sender: { receive: false } } }));
  t.after(() => hub.stop()); hub.start();
  for (let i = 0; i < 50 && !hub.receiverPolicyReady; i++) await pause(10);
  assert.equal(hub.receiverPolicyReady, true);
  blocked.resolve(); assert.equal((await stored).content, 'blocked disk write');
  assert.deepEqual(await hub.fetchHistory(), []);
});

test('S7: missing policy acknowledgements have a bounded attempt count', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  class Socket extends EventEmitter {
    constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sends = 0; this.terminated = 0; }
    send() { this.sends++; }
    close() {}
    terminate() { this.terminated++; }
  }
  const hub = new HubClient(() => ({ hubUrl: 'http://127.0.0.1:8787', deviceId: 'local' }), { WebSocketImpl: Socket, policyAckMs: 5, policyMaxAttempts: 3 });
  hub.start(); const socket = hub.ws; socket.emit('open');
  socket.emit('message', Buffer.from('{"type":"hub.config","receiverPolicyRevision":true}'));
  t.mock.timers.tick(5);
  t.mock.timers.tick(10);
  assert.equal(socket.sends, 3); assert.equal(socket.terminated, 0);
  t.mock.timers.tick(20);
  assert.equal(socket.sends, 3); assert.equal(socket.terminated, 1); hub.stop();
});

test('S7 follow-up: a rejected policy update after readiness retries and receives acknowledgement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  class Socket extends EventEmitter {
    constructor() { super(); this.OPEN = 1; this.readyState = 1; this.messages = []; }
    send(raw) {
      const message = JSON.parse(raw); this.messages.push(message);
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(this.messages.length === 2
        ? { type: 'error', code: 'control-rate-limited', message: 'retry later' }
        : { type: 'hub.receiver-policy-updated', policyRevision: message.policyRevision }))));
    }
    close() {}
  }
  let settings = { hubUrl: 'http://127.0.0.1:8787', deviceId: 'local', deviceRules: {} };
  const hub = new HubClient(() => settings, { WebSocketImpl: Socket, policyAckMs: 5,
    fetchImpl: async () => ({ ok: true, json: async () => ({ devices: [], historyDisplayLimit: 30 }) }) });
  let acknowledged = 0; hub.on('receiver-policy-updated', () => acknowledged++);
  try {
    hub.start(); const socket = hub.ws; socket.emit('open'); await new Promise((r) => setImmediate(r));
    assert.equal(hub.receiverPolicyReady, true);
    settings = { ...settings, deviceRules: { peer: { receive: false } } }; hub.sendReceiverPolicy();
    await Promise.resolve(); t.mock.timers.tick(5); await new Promise((r) => setImmediate(r));
    assert.equal(socket.messages.length, 3); assert.equal(acknowledged, 2);
    assert.deepEqual(socket.messages[2].policy.blockedSourceDeviceIds, ['peer']);
  } finally { hub.stop(); }
});

test('S7 follow-up: policy updates coalesce and stale revision acknowledgements cannot finish the latest update', async () => {
  class Socket extends EventEmitter {
    constructor() { super(); this.OPEN = 1; this.readyState = 1; this.messages = []; }
    send(raw) { this.messages.push(JSON.parse(raw)); }
    close() {}
  }
  let settings = { hubUrl: 'http://127.0.0.1:8787', deviceId: 'local', deviceRules: {} };
  const hub = new HubClient(() => settings, { WebSocketImpl: Socket,
    fetchImpl: async () => ({ ok: true, json: async () => ({ devices: [], historyDisplayLimit: 30 }) }) });
  let acknowledged = 0; hub.on('receiver-policy-updated', () => acknowledged++);
  const ack = (socket, revision) => socket.emit('message', Buffer.from(JSON.stringify({ type: 'hub.receiver-policy-updated', policyRevision: revision })));
  try {
    hub.start(); const socket = hub.ws; socket.emit('open'); ack(socket, socket.messages[0].policyRevision);
    await new Promise((r) => setImmediate(r));
    settings = { ...settings, deviceRules: { A: { receive: false } } }; hub.sendReceiverPolicy();
    settings = { ...settings, deviceRules: { B: { receive: false } } }; hub.sendReceiverPolicy();
    assert.equal(socket.messages.length, 2);
    const oldRevision = socket.messages[1].policyRevision; ack(socket, oldRevision);
    assert.equal(socket.messages.length, 3); assert.equal(acknowledged, 1);
    ack(socket, oldRevision); assert.equal(acknowledged, 1);
    ack(socket, socket.messages[2].policyRevision); assert.equal(acknowledged, 2);
    assert.deepEqual(socket.messages[2].policy.blockedSourceDeviceIds, ['B']);
    hub.sendReceiverPolicy(); assert.equal(socket.messages.length, 3);
  } finally { hub.stop(); }
});

test('S7 compatibility: an old Hub accepts unversioned ACKs but a timeout retires the ambiguous stream', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  class Socket extends EventEmitter {
    constructor() { super(); this.OPEN = 1; this.readyState = 1; this.messages = []; this.terminated = 0; }
    send(raw) { this.messages.push(JSON.parse(raw)); }
    close() {}
    terminate() { this.terminated++; this.emit('close', 1006); }
  }
  let settings = { hubUrl: 'http://127.0.0.1:8787', deviceId: 'local', deviceRules: {} };
  const hub = new HubClient(() => settings, { WebSocketImpl: Socket, policyAckMs: 5,
    fetchImpl: async () => ({ ok: true, json: async () => ({ devices: [], historyDisplayLimit: 30 }) }) });
  try {
    hub.start(); const socket = hub.ws;
    socket.emit('message', Buffer.from('{"type":"hub.config"}')); socket.emit('open');
    socket.emit('message', Buffer.from('{"type":"hub.receiver-policy-updated"}'));
    await new Promise((r) => setImmediate(r)); assert.equal(hub.receiverPolicyReady, true);
    settings = { ...settings, deviceRules: { peer: { receive: false } } }; hub.sendReceiverPolicy();
    t.mock.timers.tick(5); assert.equal(socket.messages.length, 2); assert.equal(socket.terminated, 1);
    assert.equal(hub.ws, null);
  } finally { hub.stop(); }
});
