import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClipboardSyncService } from '../src/client/sync-service.js';
import { ClipboardLoopGuard } from '../src/client/loop-guard.js';
import { textSnapshot, imageSnapshot } from '../src/client/clipboard-content.js';
import { ClipboardSnapshotReader } from '../src/client/clipboard-reader.js';
import { EventStore } from '../src/event-store.js';

function harness() {
  const h = { snapshot: textSnapshot('baseline'), settings: { deviceId: 'local', deviceRules: {} }, timers: [], writes: [], fail: true };
  h.hub = new EventEmitter();
  h.hub.sent = [];
  h.hub.sendClipboard = (snapshot) => { h.hub.sent.push(snapshot); return true; };
  h.service = new ClipboardSyncService({
    clipboard: { readSnapshot: () => h.snapshot, writeEvent: (event) => {
      h.writes.push(event.content);
      if (h.fail) throw new Error('clipboard busy');
      h.snapshot = textSnapshot(event.content);
    } }, hub: h.hub, settingsProvider: () => h.settings, devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard(), setTimeout: (fn) => { h.timers.push(fn); return fn; }, clearTimeout: () => {}
  });
  h.service.establishLocalBaseline();
  return h;
}
const remote = (content) => ({ ...textSnapshot(content), sourceDeviceId: 'remote' });

test('retry identity is stable when the same target devices appear in a different order', () => {
  const h = harness(); let now = 1000;
  h.service.now = () => now; h.service.pendingAckMs = 100;
  h.settings.deviceRules = { blocked: { send: false } };
  let devices = [{ deviceId: 'one' }, { deviceId: 'two' }, { deviceId: 'blocked' }];
  h.service.devicesProvider = () => devices;
  h.snapshot = textSnapshot('pending'); h.service.pollLocalClipboard();
  const first = h.hub.sent[0];
  devices = [...devices].reverse(); now += 101; h.service.pollLocalClipboard();
  assert.equal(h.hub.sent.length, 2);
  assert.equal(h.hub.sent[1].clientEventId, first.clientEventId);
});

test('a genuinely different target set uses a new operation identity', () => {
  const h = harness(); let now = 1000; h.service.now = () => now; h.service.pendingAckMs = 100;
  h.settings.deviceRules = { blocked: { send: false } };
  h.service.devicesProvider = () => [{ deviceId: 'one' }, { deviceId: 'two' }, { deviceId: 'blocked' }];
  h.snapshot = textSnapshot('pending'); h.service.pollLocalClipboard(); const first = h.hub.sent[0];
  h.settings.deviceRules.one = { send: false }; now += 101; h.service.pollLocalClipboard();
  assert.notEqual(h.hub.sent[1].clientEventId, first.clientEventId);
});

for (const order of [['A', 'B'], ['B', 'A']]) test(`concurrent copies converge in Hub commit order ${order.join(',')}`, () => {
  const peers = { A: harness(), B: harness() };
  const events = {};
  for (const [id, h] of Object.entries(peers)) {
    h.fail = false; h.settings.deviceId = id;
    h.snapshot = textSnapshot(id); h.service.pollLocalClipboard();
    events[id] = { ...h.hub.sent[0], sourceDeviceId: id, id, sequence: order.indexOf(id) + 1 };
  }
  for (const id of order) for (const h of Object.values(peers)) h.service.applyRemoteEvent(events[id]);
  for (const h of Object.values(peers)) {
    assert.equal(h.snapshot.content, order.at(-1));
    h.service.pollLocalClipboard();
    assert.equal(h.hub.sent.length, 1, 'committed echoes must not be sent as new copies');
  }
});

for (const newer of ['observed', 'unobserved', 'history', 'paused']) test(`own committed echo preserves ${newer} local intent`, () => {
  const h = harness(); h.fail = false;
  h.snapshot = textSnapshot('B'); h.service.pollLocalClipboard();
  const b = { ...h.hub.sent[0], sourceDeviceId: 'local', id: 'stored-B', sequence: 2 };
  h.service.applyRemoteEvent({ ...remote('A'), id: 'stored-A', sequence: 1 });
  if (newer === 'history') h.service.applyHistoryEvent(remote('C'));
  else if (newer === 'paused') h.settings.pauseReceive = true;
  else { h.snapshot = textSnapshot('C'); if (newer === 'observed') h.service.pollLocalClipboard(); }
  h.service.applyRemoteEvent(b);
  assert.equal(h.snapshot.content, newer === 'paused' ? 'A' : 'C');
});

for (const pollBeforeRetry of [false, true]) for (const staleEchoRead of [false, true]) for (const failOwnWrite of [false, true]) test(`own echo supersedes pending readback, poll first=${pollBeforeRetry}, stale=${staleEchoRead}, write fails=${failOwnWrite}`, () => {
  const h = harness(); h.fail = false;
  h.snapshot = textSnapshot('B'); h.service.pollLocalClipboard();
  const b = { ...h.hub.sent[0], sourceDeviceId: 'local', id: 'stored-B', sequence: 2 };
  let staleReads = 0;
  const read = h.service.clipboard.readSnapshot;
  const write = h.service.clipboard.writeEvent;
  let failNextOwnWrite = failOwnWrite;
  h.service.clipboard.readSnapshot = () => staleReads-- > 0 ? textSnapshot('B') : read();
  h.service.clipboard.writeEvent = (event) => {
    if (event.content === 'B' && failNextOwnWrite) { failNextOwnWrite = false; throw new Error('write busy'); }
    write(event);
    if (event.content === 'A') staleReads = staleEchoRead ? 2 : 1;
  };
  h.service.applyRemoteEvent({ ...remote('A'), id: 'stored-A', sequence: 1 });
  assert.equal(h.service.currentWrite.status, 'pending');
  h.service.applyRemoteEvent(b);
  if (pollBeforeRetry) h.service.pollLocalClipboard();
  for (const timer of h.timers.slice()) timer();
  h.service.pollLocalClipboard();
  assert.equal(h.snapshot.content, 'B');
  assert.equal(h.hub.sent.length, 1, 'a delayed remote readback is not a new local copy');
});

for (const newerCopy of [false, true]) test(`own echo retries a transient read error without overwriting a newer copy=${newerCopy}`, () => {
  const h = harness(); h.fail = false;
  h.snapshot = textSnapshot('B'); h.service.pollLocalClipboard();
  const b = { ...h.hub.sent[0], sourceDeviceId: 'local', id: 'stored-B', sequence: 2 };
  h.service.applyRemoteEvent({ ...remote('A'), id: 'stored-A', sequence: 1 });
  const read = h.service.clipboard.readSnapshot; let failRead = true;
  h.service.clipboard.readSnapshot = () => { if (failRead) throw new Error('clipboard locked'); return read(); };
  h.service.applyRemoteEvent(b);
  if (newerCopy) h.snapshot = textSnapshot('C');
  failRead = false;
  for (const timer of h.timers.slice()) timer();
  assert.equal(h.snapshot.content, newerCopy ? 'C' : 'B');
});

for (const action of ['new remote', 'local copy', 'history', 'pause', 'stop']) test(`own recovery retry is superseded by ${action}`, () => {
  const h = harness(); h.fail = false;
  h.snapshot = textSnapshot('B'); h.service.pollLocalClipboard();
  const b = { ...h.hub.sent[0], sourceDeviceId: 'local', id: 'stored-B', sequence: 2 };
  h.service.applyRemoteEvent({ ...remote('A'), id: 'stored-A', sequence: 1 });
  h.fail = true; h.service.applyRemoteEvent(b);
  assert.equal(h.service.currentWrite.status, 'pending');
  h.fail = false;
  if (action === 'new remote') h.service.applyRemoteEvent({ ...remote('C'), id: 'stored-C', sequence: 3 });
  if (action === 'local copy') h.snapshot = textSnapshot('C');
  if (action === 'history') h.service.applyHistoryEvent(remote('C'));
  if (action === 'pause') h.settings.pauseReceive = true;
  if (action === 'stop') h.service.stop();
  h.service.pollLocalClipboard();
  for (const timer of h.timers.slice()) timer();
  assert.equal(h.snapshot.content, ['pause', 'stop'].includes(action) ? 'A' : 'C');
});

test('standalone acknowledgements never reapply an overwritten local copy', () => {
  const h = harness(); h.fail = false;
  h.snapshot = textSnapshot('B'); h.service.pollLocalClipboard(); const b = h.hub.sent[0];
  h.service.applyRemoteEvent(remote('A')); const writes = h.writes.length;
  h.service.acknowledgeLocalEvent({ type: 'clipboard.ack', clientEventId: b.clientEventId });
  assert.equal(h.snapshot.content, 'A'); assert.equal(h.writes.length, writes);
});

test('exhausted own recovery does not broadcast a known peer readback as a new copy', () => {
  const h = harness(); h.fail = false; h.service.remoteWriteMaxAttempts = 2;
  h.snapshot = textSnapshot('B'); h.service.pollLocalClipboard();
  const b = { ...h.hub.sent[0], sourceDeviceId: 'local', id: 'stored-B', sequence: 2 };
  const read = h.service.clipboard.readSnapshot; const write = h.service.clipboard.writeEvent; let staleRead = false;
  h.service.clipboard.readSnapshot = () => { if (staleRead) { staleRead = false; return textSnapshot('B'); } return read(); };
  h.service.clipboard.writeEvent = (event) => { write(event); staleRead = event.content === 'A'; };
  h.service.applyRemoteEvent({ ...remote('A'), id: 'stored-A', sequence: 1 });
  h.fail = true; h.service.applyRemoteEvent(b);
  for (const timer of h.timers.slice()) { h.service.pollLocalClipboard(); timer(); }
  h.service.pollLocalClipboard();
  assert.equal(h.hub.sent.length, 1, 'known remote content must not be invented as a local operation');
  assert.equal(h.service.currentWrite?.status, 'failed');
  assert.equal(h.snapshot.content, 'A', 'failed writes must not be reported as convergence');
});

test('audit: obsolete remote retry cannot overwrite a newer successful write', () => {
  const h = harness(); h.service.applyRemoteEvent(remote('A')); h.fail = false;
  h.service.applyRemoteEvent(remote('B')); h.timers[0]();
  assert.equal(h.snapshot.content, 'B');
});
test('audit: paused receive cancels an already queued remote write', () => {
  const h = harness(); h.service.applyRemoteEvent(remote('A')); h.fail = false;
  h.settings = { ...h.settings, pauseReceive: true }; h.timers[0]();
  assert.equal(h.snapshot.content, 'baseline');
});
test('audit: local copy between retries wins even without a poll', () => {
  const h = harness(); h.service.applyRemoteEvent(remote('A')); h.fail = false;
  h.snapshot = textSnapshot('local copy'); h.timers[0]();
  assert.equal(h.snapshot.content, 'local copy');
});
for (const action of ['pause', 'stop']) test(`audit: ${action} invalidates in-flight source lookup`, async () => {
  const h = harness(); let finish;
  h.service.sourceProvider = () => new Promise((resolve) => { finish = resolve; });
  h.settings = { ...h.settings, ignoredSourcePatterns: ['blocked'] };
  h.snapshot = textSnapshot('new'); const pending = h.service.pollLocalClipboard();
  if (action === 'pause') h.settings = { ...h.settings, pauseSend: true }; else h.service.stop();
  finish({ processName: 'allowed' }); await pending;
  assert.equal(h.hub.sent.length, 0);
});
test('audit: unrelated image cannot confirm the requested image', () => {
  const h = harness(); const wanted = imageSnapshot(Buffer.from('wanted'));
  assert.equal(h.service.clipboardContainsEvent(wanted, wanted.hash, imageSnapshot(Buffer.from('old'))), false);
  assert.equal(h.service.clipboardContainsEvent(wanted, wanted.hash, wanted), true);
});
test('audit: A-B-A local copies are distinct even while B acknowledgement is delayed', () => {
  const h = harness(); h.fail = false;
  h.service.applyRemoteEvent(remote('A'));
  h.snapshot = textSnapshot('B'); h.service.pollLocalClipboard();
  h.snapshot = textSnapshot('A'); h.service.pollLocalClipboard();
  assert.deepEqual(h.hub.sent.map((event) => event.content), ['B', 'A']);
  assert.notEqual(h.hub.sent[0].clientEventId, h.hub.sent[1].clientEventId);
});
for (const origin of ['startup', 'remote']) for (const ackTiming of ['before-A', 'after-A']) {
  test(`S1: ${origin} A, B acknowledged ${ackTiming}, and a new A all preserve the last copy`, () => {
    const h = harness(); h.fail = false;
    if (origin === 'remote') h.service.applyRemoteEvent(remote('A'));
    else { h.snapshot = textSnapshot('A'); h.service.establishLocalBaseline(); }
    h.snapshot = textSnapshot('B'); h.service.pollLocalClipboard(); const b = h.hub.sent[0];
    if (ackTiming === 'before-A') h.service.acknowledgeLocalEvent({ clientEventId: b.clientEventId });
    h.snapshot = textSnapshot('A'); h.service.pollLocalClipboard();
    if (ackTiming === 'after-A') h.service.acknowledgeLocalEvent({ clientEventId: b.clientEventId });
    h.service.pollLocalClipboard();
    assert.deepEqual(h.hub.sent.map((event) => event.content), ['B', 'A']);
    assert.notEqual(h.hub.sent[0].clientEventId, h.hub.sent[1].clientEventId);
  });
}
test('audit: retry keeps its operation ID and a stale ACK does not acknowledge a new copy', () => {
  const h = harness(); let now = 1000; h.service.now = () => now; h.service.pendingAckMs = 100;
  h.snapshot = textSnapshot('A'); h.service.pollLocalClipboard();
  const a = h.hub.sent[0]; now += 101; h.service.pollLocalClipboard();
  assert.equal(h.hub.sent[1].clientEventId, a.clientEventId);
  h.snapshot = textSnapshot('B'); h.service.pollLocalClipboard();
  h.service.acknowledgeLocalEvent({ clientEventId: a.clientEventId });
  now += 101; h.service.pollLocalClipboard();
  assert.equal(h.hub.sent.at(-1).content, 'B');
  assert.equal(h.hub.sent.at(-1).clientEventId, h.hub.sent[2].clientEventId);
});
test('audit: policy invalidation preserves an already sent operation identity until its retry', () => {
  const h = harness(); let now = 1000; h.service.now = () => now; h.service.pendingAckMs = 100;
  h.snapshot = textSnapshot('A'); h.service.pollLocalClipboard();
  const first = h.hub.sent[0]; h.service.invalidatePendingWork(); h.service.pollLocalClipboard();
  assert.equal(h.hub.sent.length, 1);
  now += 101; h.service.pollLocalClipboard();
  assert.equal(h.hub.sent[1].clientEventId, first.clientEventId);
});
test('audit: a delayed readback confirms a pending write without rewriting or echoing it', () => {
  const h = harness(); h.fail = false;
  let unreadable = false;
  h.service.clipboard.readSnapshot = () => { if (unreadable) throw new Error('read temporarily busy'); return h.snapshot; };
  h.service.clipboard.writeEvent = (event) => { h.writes.push(event.content); h.snapshot = textSnapshot(event.content); unreadable = true; };
  h.service.applyRemoteEvent(remote('A')); unreadable = false; h.service.pollLocalClipboard();
  h.timers[0](); assert.deepEqual(h.writes, ['A']); assert.deepEqual(h.hub.sent, []);
  assert.equal(h.service.currentWrite.status, 'succeeded');
});
test('audit: image without a change token is refreshed at the next poll', () => {
  let n = 1; const reader = new ClipboardSnapshotReader({ now: () => 0 });
  const cb = { availableFormats: () => ['image/png'], readImage: () => ({ isEmpty: () => false, toPNG: () => Buffer.from([n]) }) };
  const a = reader.read(cb); n++; const b = reader.read(cb); assert.notEqual(a.hash, b.hash);
});
const base = { type: 'clipboard.update', sourceDeviceId: 'A', contentType: 'text/plain', encoding: 'utf8', content: 'same', byteLength: 4, sha256: 'same' };
async function storage(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-audit-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.jsonl'); const store = new EventStore(path, options); await store.ready(); return { path, store };
}
test('audit: identical content from independent devices and routes is delivered', async (t) => {
  const { store } = await storage(t);
  await store.append({ ...base, targetDeviceIds: ['B'] });
  assert.ok(await store.append({ ...base, sourceDeviceId: 'C', targetDeviceIds: ['D'] }));
});
test('audit: committed append survives failed compaction', async (t) => {
  const { store, path } = await storage(t, { maxHistoryEntries: 1 });
  await store.append(base); await mkdir(`${path}.tmp`);
  const stored = await store.append({ ...base, content: 'new' }); assert.ok(stored);
  assert.match(await readFile(path, 'utf8'), /new/);
});
test('audit: failed clear preserves in-memory history', async (t) => {
  const { store, path } = await storage(t); const event = await store.append(base); await mkdir(`${path}.tmp`);
  await assert.rejects(store.clear()); assert.deepEqual(store.recent(), [event]);
});
test('audit: idle queries do not expose expired history', async (t) => {
  let now = 1000; const { store } = await storage(t, { maxHistoryAgeMs: 100, now: () => new Date(now) });
  await store.append(base); now += 101; assert.deepEqual(store.recent(), []);
});
test('audit: valid JSON with invalid record shape is quarantined', async (t) => {
  const { path } = await storage(t); await writeFile(path, 'null\n{}\n');
  const store = new EventStore(path); await store.ready(); assert.deepEqual(store.recent(), []);
});
test('audit: history byte budget also applies to a single oversized record', async (t) => {
  const { store } = await storage(t, { maxHistoryBytes: 1024 });
  await assert.rejects(store.append({ ...base, content: 'x'.repeat(2048) }), /history byte budget/);
  assert.deepEqual(store.recent(), []);
});
