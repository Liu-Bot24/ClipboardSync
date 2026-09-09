import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { ClipboardSyncService } from '../src/client/sync-service.js';
import { ClipboardLoopGuard } from '../src/client/loop-guard.js';
import { textSnapshot } from '../src/client/clipboard-content.js';
import { normalizeHubUrl } from '../src/client/settings-validation.js';
import { HistoryRefreshController } from '../src/client/async-state.js';

const mainSource = await readFile(new URL('../src/client/electron-main.js', import.meta.url), 'utf8');
const updateSource = mainSource.slice(mainSource.indexOf('async function updateSettings(patch)'), mainSource.indexOf('\nasync function updateRule('));

function harness() {
  const state = { settings: { deviceId: 'local', hubUrl: 'http://127.0.0.1:8787', deviceRules: {} },
    clipboard: textSnapshot('baseline'), now: 1000, fail: true, timers: [], sent: [], writes: [] };
  const hub = new EventEmitter(); hub.sendClipboard = (snapshot) => { state.sent.push(snapshot); return true; };
  hub.sendReceiverPolicy = () => {}; hub.stop = () => {}; hub.start = () => {};
  state.service = new ClipboardSyncService({ hub, settingsProvider: () => state.settings, devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard(), now: () => state.now, pendingAckMs: 100,
    setTimeout: (fn) => { state.timers.push(fn); return fn; }, clearTimeout: () => {},
    clipboard: { readSnapshot: () => state.clipboard, writeEvent: (event) => {
      if (state.fail) throw new Error('temporarily busy');
      state.writes.push(event.content); state.clipboard = textSnapshot(event.content);
    } }
  });
  state.service.establishLocalBaseline();
  state.updateSettings = vm.runInNewContext(`(${updateSource})`, {
    syncService: state.service, historyRefresh: new HistoryRefreshController(), hub, normalizeHubUrl,
    configStore: { get: () => state.settings, update: async (patch) => { state.settings = { ...state.settings, ...patch }; return state.settings; } },
    setStatus: () => {}, stateForUi: () => ({}), applyHistoryAlwaysOnTop: () => {},
    applyLoginItemSettings: () => {}, broadcastState: () => {}, clearHistoryRenderCaches: () => {},
    connectionChangeRevision: 0, history: [], syncHubConnectionSettings: async () => state.settings
  });
  return state;
}

const unrelated = [{ language: 'en' }, { historyAlwaysOnTop: false }, { autoLaunch: false }, { hubUrl: 'http://[' }];
for (const patch of unrelated) {
  test(`S2: ${JSON.stringify(patch)} preserves the sent event ID`, async () => {
    const h = harness(); h.clipboard = textSnapshot('B'); h.service.pollLocalClipboard(); const first = h.sent[0];
    await h.updateSettings(patch); h.service.pollLocalClipboard(); assert.equal(h.sent.length, 1);
    h.now += 101; h.service.pollLocalClipboard(); assert.equal(h.sent[1].clientEventId, first.clientEventId);
  });
  test(`S2: ${JSON.stringify(patch)} does not cancel a legal pending remote write`, async () => {
    const h = harness(); h.service.applyRemoteEvent({ ...textSnapshot('remote'), sourceDeviceId: 'peer' });
    await h.updateSettings(patch); h.fail = false; h.timers[0]();
    assert.deepEqual(h.writes, ['remote']);
  });
}
test('S2 control: a real receive pause still invalidates the pending remote write', async () => {
  const h = harness(); h.service.applyRemoteEvent({ ...textSnapshot('remote'), sourceDeviceId: 'peer' });
  await h.updateSettings({ pauseReceive: true }); h.fail = false; h.timers[0](); assert.deepEqual(h.writes, []);
});

for (const patch of [{ pauseSend: true }, { maxSendBytes: 1 }, { ignoredSourcePatterns: ['blocked'] }, { deviceRules: { peer: { send: false } } }]) {
  test(`send-only policy ${JSON.stringify(patch)} preserves an allowed receive retry`, async () => {
    const h = harness(); h.service.applyRemoteEvent({ ...textSnapshot('remote'), sourceDeviceId: 'peer' });
    await h.updateSettings(patch); h.fail = false; h.timers[0]();
    assert.deepEqual(h.writes, ['remote']);
  });
}

test('changing receive policy preserves an explicit pending history selection', async () => {
  const h = harness(); const selection = h.service.beginHistoryWrite({ ...textSnapshot('selected history'), sourceDeviceId: 'peer' });
  await h.updateSettings({ pauseReceive: true }); h.fail = false; h.timers[0]();
  assert.equal(await selection.promise, true);
  assert.deepEqual(h.writes, ['selected history']);
});

test('blocking the pending event source still cancels its remote write', async () => {
  const h = harness(); const operation = h.service.beginWrite({ ...textSnapshot('remote'), sourceDeviceId: 'peer' }, true);
  await h.updateSettings({ deviceRules: { peer: { receive: false } } });
  h.fail = false; h.timers[0]();
  assert.equal(await operation.promise, false); assert.deepEqual(h.writes, []);
});

test('blocking the source of a pending history selection still cancels that selection', async () => {
  const h = harness(); const operation = h.service.beginHistoryWrite({ ...textSnapshot('history'), sourceDeviceId: 'peer' });
  await h.updateSettings({ deviceRules: { peer: { receive: false } } });
  h.fail = false; h.timers[0]();
  assert.equal(await operation.promise, false); assert.deepEqual(h.writes, []);
});

test('blocking an unrelated source leaves the current receive retry valid', async () => {
  const h = harness(); const operation = h.service.beginWrite({ ...textSnapshot('remote'), sourceDeviceId: 'peer' }, true);
  await h.updateSettings({ deviceRules: { other: { receive: false } } });
  h.fail = false; h.timers[0]();
  assert.equal(await operation.promise, true); assert.deepEqual(h.writes, ['remote']);
});

test('send pause during source lookup still prevents transmission', async () => {
  const h = harness(); let finishSource;
  h.settings.ignoredSourcePatterns = ['blocked'];
  h.service.sourceProvider = () => new Promise((resolve) => { finishSource = resolve; });
  h.clipboard = textSnapshot('local'); const pending = h.service.pollLocalClipboard();
  await h.updateSettings({ pauseSend: true }); finishSource({ processName: 'allowed' }); await pending;
  assert.deepEqual(h.sent, []);
});
