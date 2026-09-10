import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { ClipboardSyncService } from '../src/client/sync-service.js';
import { ClipboardLoopGuard } from '../src/client/loop-guard.js';
import { imageSnapshot, textSnapshot } from '../src/client/clipboard-content.js';
import { ConfigStore } from '../src/client/config-store.js';
import { normalizeHubUrl } from '../src/client/settings-validation.js';
import { HistoryRefreshController } from '../src/client/async-state.js';
import { mergeDeviceRules, mergeDeviceRulesByIp, updateDeviceRule } from '../src/client/policy.js';
import { HubClient } from '../src/client/hub-client.js';
import { createClipboardHubServer } from '../src/server.js';

const mainSource = await readFile(new URL('../src/client/electron-main.js', import.meta.url), 'utf8');
const settingsSource = mainSource.slice(mainSource.indexOf('async function updateSettings(patch)'), mainSource.indexOf('\nasync function updateRule('));
const remote = (content) => ({ ...textSnapshot(content), sourceDeviceId: 'peer', id: `stored-${content}` });

function harness(t) {
  const h = { value: textSnapshot('baseline'), now: 1000, online: true, timers: [], sent: [], writes: [], hubRunning: true };
  h.store = new ConfigStore(null, { path: 'unused-memory-config.json', env: {
    CLIPBOARD_CLIENT_HUB_URL: 'http://old.example', CLIPBOARD_CLIENT_DEVICE_ID: 'local'
  } });
  h.store.save = async () => {};
  h.hub = new EventEmitter();
  h.hub.sendClipboard = (snapshot) => { if (!h.online) return false; h.sent.push(snapshot); return true; };
  h.hub.sendReceiverPolicy = () => {};
  h.hub.stop = () => { h.hubRunning = false; };
  h.hub.start = () => { h.hubRunning = true; };
  h.service = new ClipboardSyncService({ hub: h.hub, settingsProvider: () => h.store.get(), devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard(), now: () => h.now, pendingAckMs: 100,
    setTimeout: (fn) => { h.timers.push(fn); return fn; }, clearTimeout: () => {},
    clipboard: { readSnapshot: () => h.value, writeEvent: (event) => { h.writes.push(event.content); h.value = textSnapshot(event.content); } }
  });
  h.service.establishLocalBaseline();
  t.after(() => h.service.stop());
  h.context = { configStore: h.store, syncService: h.service, hub: h.hub, normalizeHubUrl,
    historyRefresh: new HistoryRefreshController(), settingsUpdateQueue: Promise.resolve(), connectionChangeRevision: 0, history: [],
    setStatus: (status) => { h.status = status; }, stateForUi: () => ({}), clearHistoryRenderCaches() {},
    broadcastState() {}, applyLoginItemSettings() {}, applyHistoryAlwaysOnTop() {},
    syncHubConnectionSettings: async () => h.store.get()
  };
  h.update = vm.runInNewContext(`${settingsSource}; updateSettings`, h.context);
  return h;
}

for (const newerCopy of [false, true]) for (const history of [false, true]) {
  test(`first read failure protects a later copy: history=${history}, newer=${newerCopy}`, (t) => {
    const h = harness(t); let failRead = true;
    h.service.clipboard.readSnapshot = () => { if (failRead) { failRead = false; throw Error('read locked'); } return h.value; };
    if (history) h.service.beginHistoryWrite(remote('A')); else h.service.applyRemoteEvent(remote('A'));
    if (newerCopy) h.value = textSnapshot('new local C');
    h.timers.shift()();
    assert.equal(h.value.content, newerCopy ? 'new local C' : 'A');
    assert.equal(h.writes.length, newerCopy ? 0 : 1);
  });
}

function failReadbackAfterWrite(h) {
  let failRead = false;
  h.service.clipboard.writeEvent = (event) => { h.value = textSnapshot(event.content); h.writes.push(event.content); failRead = true; };
  h.service.clipboard.readSnapshot = () => { if (failRead) { failRead = false; throw Error('readback locked'); } return h.value; };
}

for (const patch of [{ pauseReceive: true }, { deviceRules: { peer: { receive: false } } }]) {
  test(`cancelled physical write is not a local copy: ${JSON.stringify(patch)}`, async (t) => {
    const h = harness(t); failReadbackAfterWrite(h);
    const operation = h.service.beginWrite(remote('A'), true);
    await h.update(patch);
    h.service.pollLocalClipboard();
    assert.deepEqual(h.sent, []);
    assert.equal(operation.status, 'cancelled');
    assert.equal(h.value.content, 'A');
  });
}

test('cancelled write attribution survives one stale baseline read', async (t) => {
  const h = harness(t); failReadbackAfterWrite(h);
  h.service.applyRemoteEvent(remote('A')); await h.update({ pauseReceive: true });
  h.value = textSnapshot('baseline'); h.service.pollLocalClipboard();
  h.value = textSnapshot('A'); h.service.pollLocalClipboard();
  assert.deepEqual(h.sent, []);
});

test('cancelled write evidence does not suppress an independent C then A copy', async (t) => {
  const h = harness(t); failReadbackAfterWrite(h);
  h.service.applyRemoteEvent(remote('A')); await h.update({ pauseReceive: true });
  h.value = textSnapshot('C'); h.service.pollLocalClipboard();
  h.value = textSnapshot('A'); h.service.pollLocalClipboard();
  assert.deepEqual(h.sent.map((event) => event.content), ['C', 'A']);
  assert.notEqual(h.sent[0].clientEventId, h.sent[1].clientEventId);
});

for (const image of [false, true]) for (const newerCopy of [false, true]) {
  test(`own echo read retires evidence only for a new value: image=${image}, new=${newerCopy}`, async (t) => {
    const h = harness(t);
    const value = (name) => image ? { contentType: 'image/png', encoding: 'base64', content: name,
      hash: `encoded-${name}`, pixelHash: name, byteLength: 1 } : textSnapshot(name);
    h.value = value('B'); h.service.pollLocalClipboard(); const first = h.sent[0];
    let failRead = false; const reads = [];
    h.service.clipboard.prepareWrite = (event) => {
      const name = event.content;
      return { write: () => { h.value = value(name); failRead = true; },
        matches: (snapshot) => image ? snapshot?.pixelHash === name : snapshot?.hash === textSnapshot(name).hash };
    };
    h.service.clipboard.readSnapshot = () => {
      if (failRead) { failRead = false; throw Error('readback locked'); }
      reads.push(h.value.content); return h.value;
    };
    h.service.applyRemoteEvent({ ...value('A'), id: 'stored-A', sourceDeviceId: 'peer' });
    await h.update({ pauseReceive: true });
    h.value = value(newerCopy ? 'C' : 'B');
    h.service.applyRemoteEvent({ ...first, id: 'own-B', sourceDeviceId: 'local' });
    assert.equal(reads.at(-1), newerCopy ? 'C' : 'B', 'the own-echo path must actually observe the value');
    h.value = value('A'); h.service.pollLocalClipboard();
    assert.equal(h.sent.length, newerCopy ? 2 : 1);
    if (newerCopy) assert.notEqual(h.sent[1].clientEventId, first.clientEventId);
  });
}

test('a new local value observed by write confirmation retires that operation before a later same-content copy', (t) => {
  const h = harness(t); let afterWrite = false;
  h.service.clipboard.writeEvent = (event) => { h.value = textSnapshot(event.content); afterWrite = true; };
  h.service.clipboard.readSnapshot = () => {
    if (afterWrite) { afterWrite = false; h.value = textSnapshot('new local C'); }
    return h.value;
  };
  const operation = h.service.beginWrite(remote('A'), true);
  h.value = textSnapshot('A'); h.service.pollLocalClipboard();
  assert.equal(operation.status, 'cancelled');
  assert.deepEqual(h.sent.map((event) => event.content), ['A']);
});

for (const nextCopy of ['A', 'B']) {
  test(`an unpaused own-echo observation preserves a subsequent real ${nextCopy} copy`, (t) => {
    const h = harness(t); h.value = textSnapshot('B'); h.service.pollLocalClipboard(); const first = h.sent[0];
    failReadbackAfterWrite(h); h.service.applyRemoteEvent(remote('A'));
    h.value = textSnapshot('C'); h.service.applyRemoteEvent({ ...first, id: 'own-B', sourceDeviceId: 'local' });
    h.value = textSnapshot(nextCopy); h.service.pollLocalClipboard();
    assert.deepEqual(h.sent.map((event) => event.content), ['B', nextCopy]);
    assert.notEqual(h.sent[1].clientEventId, first.clientEventId);
  });
}

test('a retry that observes new C preserves a later real copy of the original baseline', (t) => {
  const h = harness(t); let first = true;
  h.service.clipboard.readSnapshot = () => { if (first) { first = false; throw Error('initial read locked'); } return h.value; };
  h.service.applyRemoteEvent(remote('A')); h.value = textSnapshot('C'); h.timers.shift()();
  h.value = textSnapshot('baseline'); h.service.pollLocalClipboard();
  assert.deepEqual(h.sent.map((event) => event.content), ['baseline']);
});

for (const readFails of [false, true]) test(`final paste confirmation records a real new observation, readFails=${readFails}`, (t) => {
  const h = harness(t); const operation = h.service.beginHistoryWrite(remote('A'));
  assert.equal(operation.status, 'succeeded');
  if (readFails) h.service.clipboard.readSnapshot = () => { throw Error('confirm read locked'); };
  else h.value = textSnapshot('C');
  assert.equal(h.service.isWriteCurrent(operation, { confirm: true }), false);
  h.service.clipboard.readSnapshot = () => h.value;
  h.value = textSnapshot('A'); h.service.pollLocalClipboard();
  assert.equal(h.sent.length, readFails ? 0 : 1);
});

test('source recheck preserves an observed intervening value instead of rereading over it', async (t) => {
  const h = harness(t); h.service.onSourceObserved = () => {}; h.service.sourceProvider = async () => null;
  h.value = textSnapshot('B'); await h.service.pollLocalClipboard(); const first = h.sent[0];
  h.now += 101;
  const reads = [textSnapshot('B'), textSnapshot('C'), textSnapshot('B')];
  h.service.clipboard.readSnapshot = () => reads.length ? reads.shift() : h.value;
  await h.service.pollLocalClipboard();
  assert.deepEqual(h.sent.map((event) => event.content), ['B', 'B']);
  assert.notEqual(h.sent[1].clientEventId, first.clientEventId);
});

test('source recheck still confirms a known pending physical write without echoing it', async (t) => {
  const h = harness(t); h.service.onSourceObserved = () => {}; h.service.sourceProvider = async () => null;
  h.value = textSnapshot('B'); await h.service.pollLocalClipboard();
  failReadbackAfterWrite(h); h.service.applyRemoteEvent(remote('A')); h.now += 101;
  const reads = [textSnapshot('B'), textSnapshot('A')];
  h.service.clipboard.readSnapshot = () => reads.length ? reads.shift() : h.value;
  await h.service.pollLocalClipboard();
  assert.equal(h.service.currentWrite.status, 'succeeded'); assert.equal(h.sent.length, 1);
});

for (const transition of ['none', 'new-observation', 'confirmation', 'known-readback']) {
  test(`a source query cannot outlive its observation epoch: ${transition}`, async (t) => {
    const h = harness(t); h.service.onSourceObserved = () => {}; h.service.sourceProvider = async () => null;
    h.value = textSnapshot('B'); await h.service.pollLocalClipboard(); const first = h.sent[0];
    if (transition === 'confirmation' || transition === 'known-readback') {
      failReadbackAfterWrite(h); h.service.applyRemoteEvent(remote('A'));
      const reads = transition === 'known-readback' ? [textSnapshot('B'), textSnapshot('B')] : [textSnapshot('B')];
      h.service.clipboard.readSnapshot = () => reads.length ? reads.shift() : h.value;
      if (transition === 'known-readback') {
        h.service.clipboard.writeEvent = () => { throw Error('D write busy'); };
        h.service.applyRemoteEvent(remote('D'));
      }
    }
    h.now += 101; let resolveSource;
    h.service.sourceProvider = () => new Promise((resolve) => { resolveSource = resolve; });
    const query = h.service.pollLocalClipboard(); assert.equal(typeof resolveSource, 'function');
    if (transition === 'new-observation') {
      h.value = textSnapshot('C'); h.service.applyRemoteEvent({ ...first, id: 'own-B', sourceDeviceId: 'local' });
    }
    if (transition === 'confirmation' || transition === 'known-readback') {
      for (const timer of h.timers.slice()) timer();
      assert.equal(h.service.lastObservedHash, textSnapshot('A').hash);
    }
    h.value = textSnapshot('B'); h.service.sourceProvider = async () => null;
    resolveSource(null); await query;
    assert.equal(h.sent.length, transition === 'none' ? 2 : 1, 'only a query for the unchanged observation may send');
    await h.service.pollLocalClipboard();
    assert.equal(h.sent.length, 2);
    if (transition === 'none') assert.equal(h.sent[1].clientEventId, first.clientEventId);
    else assert.notEqual(h.sent[1].clientEventId, first.clientEventId);
  });
}

for (const newCopy of [false, true]) test(`an unwritten recovery target is a fresh copy only when it reappears: new=${newCopy}`, async (t) => {
  const h = harness(t); h.value = textSnapshot('B'); h.service.pollLocalClipboard(); const first = h.sent[0];
  h.service.applyRemoteEvent(remote('A'));
  h.service.remoteWriteMaxAttempts = 2; h.service.clipboard.writeEvent = () => { throw Error('restoring B failed'); };
  h.service.applyRemoteEvent({ ...first, id: 'own-B', sourceDeviceId: 'local' });
  const operation = h.service.currentWrite; assert.equal(operation.status, 'pending');
  if (newCopy) h.value = textSnapshot('B');
  h.service.pollLocalClipboard(); for (const timer of h.timers.slice()) timer(); h.service.pollLocalClipboard();
  assert.equal(await operation.promise, false);
  assert.equal(operation.status, newCopy ? 'cancelled' : 'failed');
  assert.equal(h.sent.length, newCopy ? 2 : 1);
  if (newCopy) assert.notEqual(h.sent[1].clientEventId, first.clientEventId);
});

for (const failed of [false, true]) for (const image of [false, true]) {
  test(`finished operation baselines are not permanent evidence: failed=${failed}, image=${image}`, (t) => {
    const h = harness(t);
    const value = (name) => image ? { contentType: 'image/png', encoding: 'base64', content: Buffer.from(name).toString('base64'),
      hash: `encoded-${name}`, pixelHash: name, byteLength: 1 } : textSnapshot(name);
    h.value = value('B'); h.service.pollLocalClipboard(); const first = h.sent[0];
    let failRead = false;
    h.service.remoteWriteMaxAttempts = 1;
    h.service.clipboard.prepareWrite = (event) => {
      const name = image ? Buffer.from(event.content, 'base64').toString('utf8') : event.content;
      return { write: () => { h.value = value(name); failRead = failed; },
        matches: (snapshot) => image ? snapshot?.pixelHash === name : snapshot?.hash === textSnapshot(name).hash };
    };
    h.service.clipboard.readSnapshot = () => { if (failRead) { failRead = false; throw Error('readback locked'); } return h.value; };
    h.service.applyRemoteEvent({ ...value('A'), sourceDeviceId: 'peer', id: 'stored-A' });
    assert.equal(h.service.currentWrite.status, failed ? 'failed' : 'succeeded');
    h.service.pollLocalClipboard(); assert.equal(h.sent.length, 1);
    h.value = value('B'); h.service.applyRemoteEvent({ ...first, id: 'own-B', sourceDeviceId: 'local' });
    h.value = value('A'); h.service.pollLocalClipboard();
    assert.equal(h.sent.length, 2); assert.equal(h.sent[1].hash, value('A').hash);
    assert.notEqual(h.sent[1].clientEventId, first.clientEventId);
  });
}

test('a previous submitted write does not cancel the next remote retry', (t) => {
  const h = harness(t); failReadbackAfterWrite(h);
  h.service.applyRemoteEvent(remote('A'));
  h.service.clipboard.writeEvent = () => { throw Error('second write busy'); };
  h.service.applyRemoteEvent(remote('B'));
  h.service.pollLocalClipboard();
  assert.deepEqual(h.sent, []);
  h.service.clipboard.writeEvent = (event) => { h.value = textSnapshot(event.content); };
  for (const timer of h.timers.slice()) timer();
  assert.equal(h.value.content, 'B');
});

for (const image of [false, true]) for (const history of [false, true]) for (const staleBefore of [false, true]) {
  test(`a new physical write preserves the prior readback: image=${image}, history=${history}, staleBefore=${staleBefore}`, (t) => {
    const h = harness(t);
    const value = (name) => image ? { contentType: 'image/png', encoding: 'base64', content: Buffer.from(name).toString('base64'),
      hash: `encoded-${name}`, pixelHash: name, byteLength: 1 } : textSnapshot(name);
    const reads = []; let failedRead = false;
    h.service.clipboard.readSnapshot = () => {
      if (failedRead) { failedRead = false; throw Error('A readback locked'); }
      return reads.length ? reads.shift() : h.value;
    };
    h.service.clipboard.prepareWrite = (event) => {
      const name = image ? Buffer.from(event.content, 'base64').toString('utf8') : event.content;
      return { write: () => {
        h.value = value(name);
        if (name === 'A') failedRead = true;
        if (name === 'B') reads.push(value('A'));
      }, matches: (snapshot) => image ? snapshot?.pixelHash === name : snapshot?.hash === textSnapshot(name).hash };
    };
    h.service.applyRemoteEvent({ ...value('A'), id: 'stored-A', sourceDeviceId: 'peer' });
    if (staleBefore) reads.push(textSnapshot('baseline'));
    const b = { ...value('B'), id: 'stored-B', sourceDeviceId: 'peer' };
    const operation = history ? h.service.beginHistoryWrite(b) : h.service.beginWrite(b, true);
    h.service.pollLocalClipboard();
    assert.equal(operation.status, 'succeeded');
    assert.deepEqual(h.sent, []);
    assert.equal(h.value.hash, value('B').hash);
    h.value = value('C'); h.service.pollLocalClipboard();
    h.value = value('A'); h.service.pollLocalClipboard();
    assert.equal(h.sent.length, 2, 'retired evidence must not suppress independent C and A copies');
  });
}

for (const newCopy of [false, true]) test(`unconfirmed-write capacity waits for readback and protects a new copy=${newCopy}`, (t) => {
  const h = harness(t); let stale = true;
  h.service.clipboard.readSnapshot = () => stale ? textSnapshot('baseline') : h.value;
  h.service.applyRemoteEvent(remote('A')); h.service.applyRemoteEvent(remote('B')); h.service.applyRemoteEvent(remote('C'));
  assert.deepEqual(h.writes, ['A', 'B'], 'do not issue an unbounded chain of writes without observing their results');
  stale = false; if (newCopy) h.value = textSnapshot('local D');
  h.service.pollLocalClipboard();
  for (const timer of h.timers.slice()) timer();
  assert.equal(h.value.content, newCopy ? 'local D' : 'C');
  assert.equal(h.sent.length, newCopy ? 1 : 0);
});

for (const writeBusy of [false, true]) test(`own latest commit accepts the older of two physical readbacks: busy=${writeBusy}`, (t) => {
  const h = harness(t); h.value = textSnapshot('C'); h.service.pollLocalClipboard(); const own = { ...h.sent[0], id: 'own-C', sourceDeviceId: 'local' };
  const reads = []; let failRead = false; let busy = writeBusy;
  h.service.clipboard.readSnapshot = () => {
    if (failRead) { failRead = false; throw Error('A readback locked'); }
    return reads.length ? reads.shift() : h.value;
  };
  h.service.clipboard.writeEvent = (event) => {
    if (event.content === 'C' && busy) { busy = false; throw Error('C write busy'); }
    h.value = textSnapshot(event.content);
    if (event.content === 'A') failRead = true;
    if (event.content === 'B') reads.push(textSnapshot('C'));
  };
  h.service.applyRemoteEvent(remote('A')); reads.push(textSnapshot('C')); h.service.applyRemoteEvent(remote('B'));
  reads.push(textSnapshot('A'), textSnapshot('A')); h.service.applyRemoteEvent(own);
  if (writeBusy) reads.push(textSnapshot('A'));
  for (const timer of h.timers.slice()) timer(); h.service.pollLocalClipboard();
  assert.equal(h.value.content, 'C'); assert.equal(h.sent.length, 1);
});

for (const image of [false, true]) for (const phase of ['precheck', 'first-read', 'capacity-retry']) {
  test(`own recovery shares prior evidence at ${phase}, image=${image}`, (t) => {
    const h = harness(t);
    const value = (name) => image ? { contentType: 'image/png', encoding: 'base64', content: Buffer.from(name).toString('base64'),
      hash: `encoded-${name}`, pixelHash: name, byteLength: 1 } : textSnapshot(name);
    h.value = value('C'); h.service.pollLocalClipboard(); const own = { ...h.sent[0], id: 'own-C', sourceDeviceId: 'local' };
    const reads = []; let failRead = false;
    h.service.clipboard.readSnapshot = () => {
      if (failRead) { failRead = false; throw Error('readback locked'); }
      return reads.length ? reads.shift() : h.value;
    };
    h.service.clipboard.prepareWrite = (event) => {
      const name = image ? Buffer.from(event.content, 'base64').toString('utf8') : event.content;
      return { write: () => { h.writes.push(name); h.value = value(name); failRead = name !== 'C'; },
        matches: (snapshot) => image ? snapshot?.pixelHash === name : snapshot?.hash === textSnapshot(name).hash };
    };
    h.service.applyRemoteEvent({ ...value('A'), id: 'stored-A', sourceDeviceId: 'peer' });
    reads.push(value('C')); h.service.applyRemoteEvent({ ...value('B'), id: 'stored-B', sourceDeviceId: 'peer' });
    if (phase === 'precheck') reads.push(value('A'));
    else if (phase === 'first-read') reads.push(value('C'), value('A'));
    else reads.push(value('C'), value('C'));
    h.service.applyRemoteEvent(own);
    if (phase === 'capacity-retry') {
      assert.deepEqual(h.writes, ['A', 'B']);
      reads.push(value('A')); h.service.pollLocalClipboard(); reads.push(value('A'));
    }
    for (const timer of h.timers.slice()) timer(); h.service.pollLocalClipboard();
    assert.equal(h.value.hash, value('C').hash); assert.equal(h.sent.length, 1);
    assert.equal(h.service.currentWrite.status, 'succeeded');
  });
}

for (const newerCopy of [false, true]) test(`own recovery does not overlook an older physical write when the latest write failed: new=${newerCopy}`, (t) => {
  const h = harness(t); h.value = textSnapshot('C'); h.service.pollLocalClipboard(); const own = { ...h.sent[0], id: 'own-C', sourceDeviceId: 'local' };
  const reads = []; let failRead = false;
  h.service.clipboard.readSnapshot = () => {
    if (failRead) { failRead = false; throw Error('A readback locked'); }
    return reads.length ? reads.shift() : h.value;
  };
  h.service.clipboard.writeEvent = (event) => {
    if (event.content === 'B') throw Error('B write failed');
    h.value = textSnapshot(event.content); if (event.content === 'A') failRead = true;
  };
  h.service.applyRemoteEvent(remote('A')); reads.push(textSnapshot('C')); h.service.applyRemoteEvent(remote('B'));
  if (newerCopy) h.value = textSnapshot('D'); else reads.push(textSnapshot('C'));
  h.service.applyRemoteEvent(own);
  for (const timer of h.timers.slice()) timer();
  assert.equal(h.value.content, newerCopy ? 'D' : 'C');
});

for (const newerCopy of [false, true]) test(`own recovery retires consumed predecessor values: new=${newerCopy}`, (t) => {
  const h = harness(t); h.value = textSnapshot('C'); h.service.pollLocalClipboard(); const own = { ...h.sent[0], id: 'own-C', sourceDeviceId: 'local' };
  const reads = []; let failRead = false; let busy = true;
  h.service.clipboard.readSnapshot = () => {
    if (failRead) { failRead = false; throw Error('readback locked'); }
    return reads.length ? reads.shift() : h.value;
  };
  h.service.clipboard.writeEvent = (event) => {
    if (event.content === 'C' && busy) throw Error('C busy');
    h.value = textSnapshot(event.content);
    if (event.content === 'A') failRead = true;
    if (event.content === 'B') reads.push(textSnapshot('C'));
  };
  h.service.applyRemoteEvent(remote('A')); reads.push(textSnapshot('C')); h.service.applyRemoteEvent(remote('B'));
  reads.push(textSnapshot('A'), textSnapshot('A')); h.service.applyRemoteEvent(own);
  h.service.pollLocalClipboard(); assert.equal(h.service.lastObservedHash, textSnapshot('B').hash);
  busy = false; if (newerCopy) h.value = textSnapshot('A');
  for (const timer of h.timers.slice()) timer(); h.service.pollLocalClipboard();
  assert.equal(h.value.content, newerCopy ? 'A' : 'C');
  assert.deepEqual(h.sent.map((event) => event.content), newerCopy ? ['C', 'A'] : ['C']);
});

test('cancelling with two unresolved writes recognizes both in order without broadcasting', async (t) => {
  const h = harness(t); let stale = true;
  h.service.clipboard.readSnapshot = () => stale ? textSnapshot('baseline') : h.value;
  h.service.applyRemoteEvent(remote('A')); h.service.applyRemoteEvent(remote('B'));
  await h.update({ pauseReceive: true }); stale = false;
  h.value = textSnapshot('A'); h.service.pollLocalClipboard();
  h.value = textSnapshot('B'); h.service.pollLocalClipboard();
  assert.deepEqual(h.sent, []);
  h.value = textSnapshot('C'); h.service.pollLocalClipboard();
  h.value = textSnapshot('A'); h.service.pollLocalClipboard();
  assert.deepEqual(h.sent.map((event) => event.content), ['C', 'A']);
});

test('unresolved-write backpressure exhausts honestly and does not echo the earlier physical result', (t) => {
  const h = harness(t); let stale = true;
  h.service.clipboard.readSnapshot = () => stale ? textSnapshot('baseline') : h.value;
  h.service.applyRemoteEvent(remote('A')); h.service.applyRemoteEvent(remote('B'));
  h.service.remoteWriteMaxAttempts = 2;
  const operation = h.service.beginWrite(remote('C'), true);
  for (const timer of h.timers.slice()) timer();
  assert.equal(operation.status, 'failed'); assert.deepEqual(h.writes, ['A', 'B']);
  stale = false; h.service.pollLocalClipboard();
  assert.deepEqual(h.sent, []); assert.equal(operation.status, 'failed');
  h.value = textSnapshot('C'); h.service.pollLocalClipboard();
  assert.deepEqual(h.sent.map((event) => event.content), ['C']);
});

for (const newBaseline of [false, true]) test(`Hub switch preserves delayed write provenance but retires it for a new baseline=${newBaseline}`, async (t) => {
  const h = harness(t); let stale = true;
  h.service.clipboard.readSnapshot = () => stale ? textSnapshot('baseline') : h.value;
  h.service.applyRemoteEvent(remote('A')); h.service.applyRemoteEvent(remote('B'));
  if (newBaseline) { stale = false; h.value = textSnapshot('new baseline C'); }
  await h.update({ hubUrl: 'http://new.example' });
  stale = false; h.value = textSnapshot('B'); h.service.pollLocalClipboard();
  assert.equal(h.sent.length, newBaseline ? 1 : 0);
});

for (const image of [false, true]) for (const history of [false, true]) for (const pollFirst of [false, true]) for (const newerCopy of [false, true]) {
  test(`prior write advances unread baseline: image=${image}, history=${history}, pollFirst=${pollFirst}, new=${newerCopy}`, (t) => {
    const h = harness(t);
    const value = (name) => image ? { contentType: 'image/png', encoding: 'base64', content: Buffer.from(name).toString('base64'),
      hash: `encoded-${name}`, pixelHash: name, byteLength: 1 } : textSnapshot(name);
    let failRead = false;
    h.service.clipboard.prepareWrite = (event) => {
      const name = image ? Buffer.from(event.content, 'base64').toString('utf8') : event.content;
      return { write: () => { h.value = value(name); if (name === 'A') failRead = true; },
        matches: (snapshot) => image ? snapshot?.pixelHash === name : snapshot?.hash === textSnapshot(name).hash };
    };
    h.service.clipboard.readSnapshot = () => { if (failRead) { failRead = false; throw Error('read locked'); } return h.value; };
    h.service.applyRemoteEvent({ ...value('A'), sourceDeviceId: 'peer', id: 'stored-A' });
    failRead = true;
    const b = { ...value('B'), sourceDeviceId: 'peer', id: 'stored-B' };
    if (history) h.service.beginHistoryWrite(b); else h.service.applyRemoteEvent(b);
    if (pollFirst) h.service.pollLocalClipboard();
    assert.deepEqual(h.sent, []);
    if (newerCopy) h.value = value('C');
    for (const timer of h.timers.slice()) timer();
    h.service.pollLocalClipboard();
    assert.equal(h.value.hash, value(newerCopy ? 'C' : 'B').hash);
    assert.equal(h.sent.length, newerCopy ? 1 : 0);
  });
}

for (const newerCopy of [false, true]) test(`a stale first observation followed by a failed write accepts a known prior readback: new=${newerCopy}`, (t) => {
  const h = harness(t); failReadbackAfterWrite(h); h.service.applyRemoteEvent(remote('A'));
  let stale = true; let writeFails = true;
  h.service.clipboard.readSnapshot = () => { if (stale) { stale = false; return textSnapshot('baseline'); } return h.value; };
  h.service.clipboard.writeEvent = (event) => { if (writeFails) { writeFails = false; throw Error('busy'); } h.value = textSnapshot(event.content); };
  h.service.applyRemoteEvent(remote('B')); h.service.pollLocalClipboard(); assert.deepEqual(h.sent, []);
  if (newerCopy) h.value = textSnapshot('C');
  for (const timer of h.timers.slice()) timer();
  assert.equal(h.value.content, newerCopy ? 'C' : 'B');
});

test('cancelling own recovery after stale baseline reads still recognizes the prior physical write', async (t) => {
  const h = harness(t); h.value = textSnapshot('B'); h.service.pollLocalClipboard();
  const own = { ...h.sent[0], id: 'own-B', sourceDeviceId: 'local' };
  let staleReads = 0;
  h.service.clipboard.readSnapshot = () => staleReads-- > 0 ? textSnapshot('B') : h.value;
  h.service.clipboard.writeEvent = (event) => {
    if (event.content === 'B') throw Error('restoring B is busy');
    h.value = textSnapshot(event.content); staleReads = 4;
  };
  h.service.applyRemoteEvent(remote('A')); h.service.applyRemoteEvent(own);
  h.service.pollLocalClipboard();
  await h.update({ pauseReceive: true }); h.service.pollLocalClipboard();
  assert.equal(h.value.content, 'A');
  assert.equal(h.sent.length, 1, 'the old physical A must not be rebroadcast after cancellation');
});

test('failed connection save keeps the old configuration and running service', async (t) => {
  const h = harness(t); const previous = h.store.get();
  h.store.save = async () => { throw Error('disk full'); };
  await h.update({ hubUrl: 'http://new.example' });
  assert.equal(h.status.state, 'config-error');
  assert.equal(h.store.get(), previous);
  assert.equal(h.hubRunning, true);
  assert.equal(h.service.stopped, false);
  assert.equal(h.context.historyRefresh.enabled, true);
});

for (const sentBeforeRename of [false, true]) {
  test(`renaming preserves an offline copy and its retry ID: submitted=${sentBeforeRename}`, async (t) => {
    const h = harness(t); h.online = sentBeforeRename; h.value = textSnapshot('offline B');
    h.service.pollLocalClipboard(); const id = h.service.localEvent.id;
    h.online = false; await h.update({ deviceName: 'Renamed' });
    h.online = true; h.now += 101; h.service.pollLocalClipboard();
    assert.equal(h.sent.at(-1)?.content, 'offline B');
    assert.equal(h.sent.at(-1)?.clientEventId, id);
    assert.equal(h.sent.length, sentBeforeRename ? 2 : 1);
  });
}

test('switching to a different Hub does not send the old pending copy there', async (t) => {
  const h = harness(t); h.online = false; h.value = textSnapshot('old Hub pending copy'); h.service.pollLocalClipboard();
  await h.update({ hubUrl: 'http://new.example' });
  h.online = true; h.service.pollLocalClipboard();
  assert.deepEqual(h.sent, []);
  assert.equal(h.hubRunning, true);
  assert.equal(h.service.stopped, false);
});

test('ConfigStore does not publish a failed filesystem write or leak it into the next patch', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-settings-transaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const store = new ConfigStore(null, { path, env: { CLIPBOARD_CLIENT_HUB_URL: 'http://old.example' } });
  await store.save();
  await mkdir(`${path}.tmp`);
  await assert.rejects(store.update({ hubUrl: 'http://failed.example' }));
  assert.equal(store.get().hubUrl, 'http://old.example');
  await rm(`${path}.tmp`, { recursive: true });
  await store.update({ language: 'en' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).hubUrl, 'http://old.example');
  assert.equal(store.get().language, 'en');
});

test('a failed queued setting does not leak into a later successful setting', async (t) => {
  const h = harness(t); let completeFirst; let calls = 0;
  h.store.save = () => ++calls === 1 ? new Promise((resolve, reject) => { completeFirst = () => reject(Error('first save failed')); }) : Promise.resolve();
  const first = h.store.update({ hubUrl: 'http://failed.example' });
  const failed = assert.rejects(first);
  const second = h.store.update({ language: 'en' });
  await new Promise((resolve) => setImmediate(resolve));
  completeFirst(); await failed; await second;
  assert.equal(h.store.get().hubUrl, 'http://old.example');
  assert.equal(h.store.get().language, 'en');
});

test('a queued rule merge observes the last committed user restriction', async (t) => {
  const h = harness(t); let release;
  h.store.save = () => new Promise((resolve) => { release = resolve; });
  const userUpdate = h.store.update({ deviceRules: { peer: { receive: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  h.store.save = async () => {};
  const start = mainSource.indexOf("async (nextDevices) => {", mainSource.indexOf("hub.on('devices'"));
  const end = mainSource.indexOf("\n  hub.on('config'", start);
  const callbackSource = mainSource.slice(start, end).trim().replace(/\);$/, '');
  const onDevices = vm.runInNewContext(`(${callbackSource})`, {
    configStore: h.store, devices: [], hub: h.hub, mergeDeviceRules, mergeDeviceRulesByIp,
    smokeTrace() {}, broadcastState() {}, setStatus() {}, currentHubSettings: () => h.store.get()
  });
  const merge = onDevices([{ deviceId: 'peer', ip: '192.0.2.1' }, { deviceId: 'other', ip: '192.0.2.2' }]);
  release(); await userUpdate; await merge;
  assert.equal(h.store.get().deviceRules.peer.receive, false);
  assert.equal(h.store.get().deviceRules.other.receive, true);
});

test('a newly observed unrelated value retires old write evidence before another write fails', async (t) => {
  const h = harness(t); failReadbackAfterWrite(h);
  h.service.applyRemoteEvent(remote('A')); await h.update({ pauseReceive: true });
  h.value = textSnapshot('C');
  h.service.clipboard.writeEvent = () => { throw Error('history write busy'); };
  h.service.beginHistoryWrite(remote('B'));
  h.value = textSnapshot('A');
  for (const timer of h.timers.slice()) timer();
  h.service.pollLocalClipboard();
  assert.deepEqual(h.sent.map((event) => event.content), ['A']);
});

test('a new Hub never inherits an old pending copy when startup read fails', async (t) => {
  const h = harness(t); h.online = false; h.value = textSnapshot('old pending B'); h.service.pollLocalClipboard();
  let first = true;
  h.service.clipboard.readSnapshot = () => { if (first) { first = false; throw Error('startup read locked'); } return h.value; };
  await h.update({ hubUrl: 'http://new.example' }); h.online = true; h.service.pollLocalClipboard();
  assert.deepEqual(h.sent, []);
});

test('saving an unchanged connection address preserves the pending operation', async (t) => {
  const h = harness(t); h.value = textSnapshot('pending B'); h.service.pollLocalClipboard(); const id = h.sent[0].clientEventId;
  await h.update({ hubUrl: h.store.get().hubUrl }); h.now += 101; h.service.pollLocalClipboard();
  assert.equal(h.sent.length, 2); assert.equal(h.sent[1].clientEventId, id);
});

test('failed policy persistence leaves the permitted incoming retry alive', async (t) => {
  const h = harness(t); h.service.clipboard.writeEvent = () => { throw Error('busy'); };
  const operation = h.service.beginWrite(remote('A'), true);
  h.store.save = async () => { throw Error('save failed'); };
  await h.update({ pauseReceive: true });
  h.service.clipboard.writeEvent = (event) => { h.value = textSnapshot(event.content); };
  h.timers.shift()(); assert.equal(await operation.promise, true); assert.equal(h.value.content, 'A');
});

test('cancelled image write uses canonical pixels and still permits a different image', async (t) => {
  const h = harness(t); let failRead = false;
  const picture = (pixelHash) => ({ contentType: 'image/png', encoding: 'base64', content: 'encoded', hash: `encoded-${pixelHash}`, pixelHash });
  h.service.clipboard.prepareWrite = () => ({ write: () => { h.value = picture('A'); failRead = true; }, matches: (snapshot) => snapshot?.pixelHash === 'A' });
  h.service.clipboard.readSnapshot = () => { if (failRead) { failRead = false; throw Error('readback locked'); } return h.value; };
  h.service.applyRemoteEvent({ ...picture('original-A-encoding'), sourceDeviceId: 'peer' });
  await h.update({ pauseReceive: true }); h.service.pollLocalClipboard(); assert.deepEqual(h.sent, []);
  h.value = picture('C'); h.service.pollLocalClipboard(); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].pixelHash, 'C');
});

test('rapid rule clicks merge against the preceding accepted setting', async (t) => {
  const h = harness(t);
  const start = mainSource.indexOf('async function updateRule(');
  const end = mainSource.indexOf('\nasync function applyHistory(', start);
  const updateRule = vm.runInNewContext(`${mainSource.slice(start, end)}; updateRule`, {
    updateSettings: h.update, configStore: h.store, devices: [], updateDeviceRule, stateForUi: () => ({})
  });
  await Promise.all([updateRule('one', 'receive', false), updateRule('two', 'receive', false)]);
  assert.equal(h.store.get().deviceRules.one.receive, false);
  assert.equal(h.store.get().deviceRules.two.receive, false);
});

test('a failed Hub change followed by rename preserves the original pending copy', async (t) => {
  const h = harness(t); h.online = false; h.value = textSnapshot('B'); h.service.pollLocalClipboard(); const id = h.service.localEvent.id;
  let saves = 0; h.store.save = async () => { if (++saves === 1) throw Error('first save failed'); };
  await Promise.all([h.update({ hubUrl: 'http://failed.example' }), h.update({ deviceName: 'Renamed' })]);
  assert.equal(h.store.get().hubUrl, 'http://old.example');
  h.online = true; h.service.pollLocalClipboard();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].clientEventId, id);
});

test('a Hub change followed by rename restarts the latest connection without reviving old work', async (t) => {
  const h = harness(t); h.online = false; h.value = textSnapshot('old B'); h.service.pollLocalClipboard();
  let finishProxy; let syncCalls = 0;
  h.context.syncHubConnectionSettings = () => ++syncCalls === 1 ? new Promise((resolve) => { finishProxy = () => resolve(h.store.get()); }) : Promise.resolve(h.store.get());
  const change = h.update({ hubUrl: 'http://new.example' });
  const rename = h.update({ deviceName: 'Renamed' });
  await new Promise((resolve) => setImmediate(resolve)); finishProxy();
  await Promise.all([change, rename]);
  assert.equal(h.store.get().deviceName, 'Renamed'); assert.equal(h.store.get().hubUrl, 'http://new.example');
  assert.equal(h.hubRunning, true); assert.equal(h.service.stopped, false);
  h.online = true; h.service.pollLocalClipboard(); assert.deepEqual(h.sent, []);
});

function connected(hub) {
  return new Promise((resolve) => {
    const listener = (status) => { if (status.state === 'connected') { hub.off('status', listener); resolve(); } };
    hub.on('status', listener);
  });
}

test('real Hub rename preserves lost-ACK identity and an offline copy', { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-rename-session-'));
  const server = await createClipboardHubServer({ host: '127.0.0.1', port: 0, historyPath: join(dir, 'history.jsonl') });
  const h = harness(t); let receiver;
  t.after(async () => { h.service.stop(); h.hub.stop(); receiver?.stop(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await server.listen();
  h.store.path = join(dir, 'config.json'); h.store.save = ConfigStore.prototype.save;
  await h.store.update({ hubUrl: `http://127.0.0.1:${server.address().port}` });
  h.hub = new HubClient(() => h.store.get()); h.context.hub = h.hub; h.service.hub = h.hub;
  receiver = new HubClient(() => ({ ...h.store.get(), deviceId: 'receiver', deviceName: 'Receiver' }));
  const deliveries = []; receiver.on('clipboard', (event) => deliveries.push(event));
  const ready = Promise.all([connected(h.hub), connected(receiver)]);
  h.service.start(); h.hub.start(); receiver.start(); await ready;
  let dropConfirmation = true; const emit = h.hub.emit.bind(h.hub);
  h.hub.emit = (name, ...args) => {
    if (dropConfirmation && (name === 'ack' || (name === 'clipboard' && args[0].sourceDeviceId === 'local'))) return false;
    return emit(name, ...args);
  };
  h.value = textSnapshot('B'); const delivered = once(receiver, 'clipboard'); h.service.pollLocalClipboard(); await delivered;
  const id = h.service.localEvent.id;
  const reconnected = connected(h.hub); await h.update({ deviceName: 'Renamed' }); await reconnected;
  dropConfirmation = false; h.now += 101;
  const acknowledged = once(h.hub, 'ack'); h.service.pollLocalClipboard(); await acknowledged;
  const history = await h.hub.fetchHistory();
  assert.equal(history.length, 1); assert.equal(history[0].clientEventId, id);
  assert.equal(deliveries.length, 1);
  h.hub.stop(); h.value = textSnapshot('offline C'); h.service.pollLocalClipboard();
  const onlineAgain = connected(h.hub); await h.update({ deviceName: 'Renamed again' }); await onlineAgain;
  const nextDelivery = once(receiver, 'clipboard'); h.service.pollLocalClipboard(); await nextDelivery;
  assert.deepEqual(deliveries.map((event) => event.content), ['B', 'offline C']);
  assert.equal((await h.hub.fetchHistory()).length, 2);
});

for (const image of [false, true]) test(`real Hub stores two distinct B copies across a stale source query: image=${image}`, { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-source-session-'));
  const server = await createClipboardHubServer({ host: '127.0.0.1', port: 0, historyPath: join(dir, 'history.jsonl') });
  const h = harness(t); let receiver;
  t.after(async () => { h.service.stop(); h.hub.stop(); receiver?.stop(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await server.listen(); await h.store.update({ hubUrl: `http://127.0.0.1:${server.address().port}` });
  h.hub = new HubClient(() => h.store.get()); h.service.hub = h.hub; h.service.pollMs = 60_000;
  h.service.onSourceObserved = () => {}; h.service.sourceProvider = async () => null;
  receiver = new HubClient(() => ({ ...h.store.get(), deviceId: 'receiver', deviceName: 'Receiver' }));
  const deliveries = []; receiver.on('clipboard', (event) => deliveries.push(event));
  const ready = Promise.all([connected(h.hub), connected(receiver)]);
  h.service.start(); h.hub.start(); receiver.start(); await ready;
  let hold = true; let ownEvent; let gotOwn;
  const ownCaptured = new Promise((resolve) => { gotOwn = resolve; }); const emit = h.hub.emit.bind(h.hub);
  h.hub.emit = (name, ...args) => {
    if (hold && name === 'clipboard' && args[0].sourceDeviceId === 'local') { ownEvent = args[0]; gotOwn(); return false; }
    if (hold && name === 'ack') return false;
    return emit(name, ...args);
  };
  const b = image ? imageSnapshot(await readFile(new URL('../src/client/tray-icon.png', import.meta.url))) : textSnapshot('B');
  h.value = b; const firstDelivery = once(receiver, 'clipboard'); await h.service.pollLocalClipboard();
  await Promise.all([firstDelivery, ownCaptured]);
  let resolveSource; h.now += 101; h.service.sourceProvider = () => new Promise((resolve) => { resolveSource = resolve; });
  const query = h.service.pollLocalClipboard(); assert.equal(typeof resolveSource, 'function');
  h.value = textSnapshot('C'); emit('clipboard', ownEvent);
  h.value = b; hold = false; h.service.sourceProvider = async () => null; resolveSource(null); await query;
  const nextDelivery = once(receiver, 'clipboard'); const acknowledged = once(h.hub, 'ack');
  await h.service.pollLocalClipboard(); await Promise.all([nextDelivery, acknowledged]);
  const history = await h.hub.fetchHistory();
  assert.equal(history.length, 2); assert.equal(deliveries.length, 2);
  assert.ok(history.every((event) => event.sha256 === b.hash));
  assert.notEqual(history[0].clientEventId, history[1].clientEventId);
});

test('settings result explicitly distinguishes failed validation, persistence failure and accepted save', async t => {
  const h = harness(t);
  assert.equal((await h.update({ hubUrl: 'http://[' })).settingsSaved, false);
  h.store.save = async () => { throw Error('disk full'); };
  assert.equal((await h.update({ hubUrl: 'http://new.example' })).settingsSaved, false);
  assert.equal(h.store.get().hubUrl, 'http://old.example');
  h.store.save = async () => {};
  assert.equal((await h.update({ hubUrl: 'http://new.example' })).settingsSaved, true);
  assert.equal(h.store.get().hubUrl, 'http://new.example');
});
