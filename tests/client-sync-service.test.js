import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { hashEventPayload } from '../src/client/clipboard-content.js';
import { ClipboardLoopGuard } from '../src/client/loop-guard.js';
import { ClipboardSyncService } from '../src/client/sync-service.js';

function fakeHub() {
  const emitter = new EventEmitter();
  emitter.sent = [];
  emitter.sendClipboard = (snapshot, targetDeviceIds) => {
    emitter.sent.push({ snapshot, targetDeviceIds });
    return true;
  };
  return emitter;
}

function fakeHubWithResults(results) {
  const hub = fakeHub();
  hub.sendClipboard = (snapshot, targetDeviceIds) => {
    const result = results.shift();
    if (result) {
      hub.sent.push({ snapshot, targetDeviceIds });
    }
    return result;
  };
  return hub;
}

test('ClipboardSyncService sends local clipboard changes to allowed target devices', () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0' };
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({
      deviceId: 'macbook',
      pauseSend: false,
      deviceRules: {
        'main-pc': { send: true, receive: true },
        'mac-mini': { send: false, receive: true }
      }
    }),
    devicesProvider: () => [
      { deviceId: 'macbook', ip: '192.0.2.10' },
      { deviceId: 'main-pc', ip: '192.0.2.20' },
      { deviceId: 'mac-mini', ip: '192.0.2.30' }
    ],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'hi', hash: 'hash-1' };
  service.pollLocalClipboard();

  assert.equal(hub.sent.length, 1);
  assert.deepEqual(hub.sent[0].targetDeviceIds, ['main-pc']);
});

test('ClipboardSyncService does not broadcast the clipboard that existed before startup', () => {
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => ({ contentType: 'text/plain', encoding: 'utf8', content: 'already there', hash: 'hash-0' }),
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  service.pollLocalClipboard();

  assert.deepEqual(hub.sent, []);
});

test('ClipboardSyncService establishes startup baseline before the first timer poll', () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'already there', hash: 'hash-0' };
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    pollMs: 60_000
  });

  service.start();
  service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'copied after startup', hash: 'hash-1' };
  service.pollLocalClipboard();
  service.stop();

  assert.equal(hub.sent.length, 1);
  assert.equal(hub.sent[0].snapshot.content, 'copied after startup');
});

test('ClipboardSyncService writes allowed remote events without rebroadcasting them', () => {
  const written = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => ({ contentType: 'text/plain', encoding: 'utf8', content: 'remote', hash: 'remote-hash' }),
      writeEvent: (event) => written.push(event)
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseReceive: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  const event = {
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'text/plain',
    encoding: 'utf8',
    content: 'remote',
    sha256: 'remote-hash'
  };
  service.applyRemoteEvent(event);
  service.pollLocalClipboard();

  assert.deepEqual(written, [event]);
  assert.deepEqual(hub.sent, []);
});

test('ClipboardSyncService sends the same content again after the clipboard was cleared', () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'repeat', hash: 'repeat-hash' };
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  service.pollLocalClipboard();
  snapshot = null;
  service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'repeat', hash: 'repeat-hash' };
  service.pollLocalClipboard();

  assert.equal(hub.sent.length, 1);
});

test('ClipboardSyncService retries an unsent local change after the Hub reconnects', () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0' };
  const hub = fakeHubWithResults([false, true]);
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'copied while offline', hash: 'hash-1' };
  service.pollLocalClipboard();
  service.pollLocalClipboard();

  assert.equal(hub.sent.length, 1);
  assert.equal(hub.sent[0].snapshot.content, 'copied while offline');
});

test('ClipboardSyncService waits for the Hub echo before treating a local send as synced', () => {
  let now = 1_000;
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0' };
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => now }),
    now: () => now,
    pendingAckMs: 100
  });

  service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'copied', hash: 'hash-1' };
  service.pollLocalClipboard();
  service.pollLocalClipboard();

  assert.equal(hub.sent.length, 1);

  service.applyRemoteEvent({
    sourceDeviceId: 'macbook',
    sourceIp: '192.0.2.10',
    contentType: 'text/plain',
    encoding: 'utf8',
    content: 'copied',
    sha256: 'hash-1'
  });
  service.pollLocalClipboard();

  assert.equal(hub.sent.length, 1);

  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'retry me', hash: 'hash-2' };
  service.pollLocalClipboard();
  now = 1_101;
  service.pollLocalClipboard();

  assert.equal(hub.sent.length, 3);
  assert.equal(hub.sent[2].snapshot.content, 'retry me');
});

test('ClipboardSyncService retries a restricted send after the device list loads', () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0' };
  let devices = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({
      deviceId: 'macbook',
      pauseSend: false,
      deviceRules: {
        'main-pc': { send: true, receive: true },
        'mac-mini': { send: false, receive: true }
      }
    }),
    devicesProvider: () => devices,
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'copied before devices loaded', hash: 'hash-1' };
  service.pollLocalClipboard();
  devices = [
    { deviceId: 'macbook', ip: '192.0.2.10' },
    { deviceId: 'main-pc', ip: '192.0.2.20' },
    { deviceId: 'mac-mini', ip: '192.0.2.30' }
  ];
  service.pollLocalClipboard();

  assert.equal(hub.sent.length, 1);
  assert.equal(hub.sent[0].snapshot.content, 'copied before devices loaded');
  assert.deepEqual(hub.sent[0].targetDeviceIds, ['main-pc']);
});

test('ClipboardSyncService does not retry a changed clipboard while sending is paused', () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0' };
  const hub = fakeHub();
  const settings = { deviceId: 'macbook', pauseSend: true, deviceRules: {} };
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => settings,
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'paused copy', hash: 'hash-1' };
  service.pollLocalClipboard();
  settings.pauseSend = false;
  service.pollLocalClipboard();

  assert.deepEqual(hub.sent, []);
});

test('ClipboardSyncService skips oversized local clipboard payloads', () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0', byteLength: 7 };
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({
      deviceId: 'macbook',
      pauseSend: false,
      maxSendBytes: 10,
      deviceRules: {}
    }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  service.pollLocalClipboard();
  snapshot = {
    contentType: 'image/png',
    encoding: 'base64',
    content: Buffer.alloc(11).toString('base64'),
    hash: 'hash-oversized',
    byteLength: 11
  };
  service.pollLocalClipboard();
  service.pollLocalClipboard();

  assert.deepEqual(hub.sent, []);
});

test('ClipboardSyncService skips local clipboard changes from ignored source applications', async () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0' };
  const traces = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({
      deviceId: 'macbook',
      pauseSend: false,
      ignoredSourcePatterns: ['voice input'],
      deviceRules: {}
    }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    sourceProvider: () => ({ processName: 'Voice Input Helper', title: 'dictating into editor' }),
    onTrace: (event) => traces.push(event)
  });

  await service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'dictated text', hash: 'hash-1' };
  await service.pollLocalClipboard();
  await service.pollLocalClipboard();

  assert.deepEqual(hub.sent, []);
  assert.equal(traces.at(-1).stage, 'local-event-ignored');
  assert.equal(traces.at(-1).source.processName, 'Voice Input Helper');
});

test('ClipboardSyncService skips local clipboard changes when unknown copy sources are ignored', async () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0' };
  const traces = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({
      deviceId: 'macbook',
      pauseSend: false,
      ignoreUnknownSource: true,
      ignoredSourcePatterns: [],
      deviceRules: {}
    }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    sourceProvider: () => null,
    onTrace: (event) => traces.push(event)
  });

  await service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'dictated text', hash: 'hash-1' };
  await service.pollLocalClipboard();

  assert.deepEqual(hub.sent, []);
  assert.equal(traces.at(-1).stage, 'local-event-ignored');
  assert.equal(traces.at(-1).source, null);
});

test('ClipboardSyncService treats empty clipboard owner objects as unknown copy sources', async () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0' };
  const traces = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({
      deviceId: 'macbook',
      pauseSend: false,
      ignoreUnknownSource: true,
      ignoredSourcePatterns: [],
      deviceRules: {}
    }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    sourceProvider: () => ({
      platform: 'win32',
      ownerHwnd: 0,
      ownerPid: 0,
      processName: '',
      title: ''
    }),
    onTrace: (event) => traces.push(event)
  });

  await service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'dictated text', hash: 'hash-1' };
  await service.pollLocalClipboard();

  assert.deepEqual(hub.sent, []);
  assert.equal(traces.at(-1).stage, 'local-event-ignored');
  assert.equal(traces.at(-1).source.ownerPid, 0);
});

test('ClipboardSyncService records local clipboard sources even before ignore rules exist', async () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0' };
  const observed = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({
      deviceId: 'macbook',
      pauseSend: false,
      ignoredSourcePatterns: [],
      deviceRules: {}
    }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    sourceProvider: () => ({ processName: 'Voice Input Helper', title: 'dictating into editor' }),
    onSourceObserved: (event) => observed.push(event)
  });

  await service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'dictated text', hash: 'hash-1' };
  await service.pollLocalClipboard();

  assert.equal(observed.length, 1);
  assert.equal(observed[0].source.processName, 'Voice Input Helper');
  assert.equal(observed[0].contentType, 'text/plain');
  assert.equal(hub.sent.length, 1);
});

test('ClipboardSyncService rechecks the clipboard after asynchronous source reads', async () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'startup', hash: 'hash-0' };
  let sourceReads = 0;
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({
      deviceId: 'macbook',
      pauseSend: false,
      ignoredSourcePatterns: ['blocked source'],
      deviceRules: {}
    }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    sourceProvider: async () => {
      sourceReads += 1;
      if (sourceReads === 1) {
        snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'newer copy', hash: 'hash-2' };
      }
      return { processName: 'Allowed Source', title: 'copy source' };
    }
  });

  await service.pollLocalClipboard();
  snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'older copy', hash: 'hash-1' };
  await service.pollLocalClipboard();

  assert.equal(sourceReads, 2);
  assert.equal(hub.sent.length, 1);
  assert.equal(hub.sent[0].snapshot.content, 'newer copy');
});

test('ClipboardSyncService reports clipboard read errors without crashing or sending', () => {
  const errors = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => {
        throw new Error('clipboard read failed');
      },
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    onError: (error) => errors.push(error.message)
  });

  assert.doesNotThrow(() => service.pollLocalClipboard());
  assert.deepEqual(hub.sent, []);
  assert.deepEqual(errors, ['clipboard read failed']);
});

test('ClipboardSyncService suppresses remote images after platform re-encodes them', () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'baseline', hash: 'baseline-hash' };
  const written = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: (event) => {
        written.push(event);
        snapshot = { contentType: 'image/png', encoding: 'base64', content: 'reencoded', hash: 'actual-image-hash' };
      }
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseReceive: false, pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  service.pollLocalClipboard();
  service.applyRemoteEvent({
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'image/png',
    encoding: 'base64',
    content: 'original',
    sha256: 'remote-image-hash'
  });
  service.pollLocalClipboard();

  assert.equal(written.length, 1);
  assert.deepEqual(hub.sent, []);
});

test('ClipboardSyncService retries remote image writes when the observable image stayed unchanged', () => {
  const scheduled = [];
  const oldImage = { contentType: 'image/png', encoding: 'base64', content: 'old-image', hash: 'old-image-hash' };
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => oldImage,
      writeEvent: () => {}
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseReceive: false, pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    remoteWriteRetryMs: 1,
    remoteWriteMaxAttempts: 2,
    setTimeout: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    clearTimeout: () => {}
  });

  service.pollLocalClipboard();
  service.applyRemoteEvent({
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'image/png',
    encoding: 'base64',
    content: 'new-image'
  });

  assert.equal(scheduled.length, 1);
  assert.deepEqual(hub.sent, []);
});

test('ClipboardSyncService accepts a remote image when the same payload is already observable', () => {
  const event = {
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'image/png',
    encoding: 'base64',
    content: Buffer.from('same-image').toString('base64')
  };
  const hash = hashEventPayload(event);
  const written = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => ({ contentType: 'image/png', encoding: 'base64', content: event.content, hash }),
      writeEvent: (received) => written.push(received)
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseReceive: false, pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    remoteWriteMaxAttempts: 1
  });

  service.pollLocalClipboard();
  service.applyRemoteEvent(event);
  service.pollLocalClipboard();

  assert.equal(written.length, 1);
  assert.deepEqual(hub.sent, []);
});

test('ClipboardSyncService reports clipboard write errors without crashing', () => {
  const errors = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => ({ contentType: 'text/plain', encoding: 'utf8', content: 'baseline', hash: 'baseline-hash' }),
      writeEvent: () => {
        throw new Error('clipboard write failed');
      }
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseReceive: false, pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    onError: (error) => errors.push(error.message),
    remoteWriteMaxAttempts: 1
  });

  assert.doesNotThrow(() =>
    service.applyRemoteEvent({
      sourceDeviceId: 'main-pc',
      sourceIp: '192.0.2.20',
      contentType: 'text/plain',
      encoding: 'utf8',
      content: 'remote',
      sha256: 'remote-hash'
    })
  );
  assert.deepEqual(errors, ['clipboard write failed']);
});

test('ClipboardSyncService retries transient remote clipboard write failures', () => {
  const errors = [];
  const scheduled = [];
  let attempts = 0;
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'baseline', hash: 'baseline-hash' };
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('clipboard busy');
        }
        snapshot = { contentType: 'image/png', encoding: 'base64', content: 'rewritten', hash: 'actual-image-hash' };
      }
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseReceive: false, pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    onError: (error) => errors.push(error.message),
    remoteWriteRetryMs: 1,
    remoteWriteMaxAttempts: 2,
    setTimeout: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    clearTimeout: () => {}
  });

  service.pollLocalClipboard();
  service.applyRemoteEvent({
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'image/png',
    encoding: 'base64',
    content: 'original',
    sha256: 'remote-image-hash'
  });

  assert.equal(attempts, 1);
  assert.deepEqual(errors, ['clipboard busy']);
  assert.equal(scheduled.length, 1);

  scheduled.shift()();
  service.pollLocalClipboard();

  assert.equal(attempts, 2);
  assert.deepEqual(hub.sent, []);
});

test('ClipboardSyncService retries remote image writes until they are observable', () => {
  const scheduled = [];
  let attempts = 0;
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'baseline', hash: 'baseline-hash' };
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: () => {
        attempts += 1;
        if (attempts === 2) {
          snapshot = { contentType: 'image/png', encoding: 'base64', content: 'written', hash: 'actual-image-hash' };
        }
      }
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseReceive: false, pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    remoteWriteRetryMs: 1,
    remoteWriteMaxAttempts: 2,
    setTimeout: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    clearTimeout: () => {}
  });

  service.pollLocalClipboard();
  service.applyRemoteEvent({
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'image/png',
    encoding: 'base64',
    content: 'original',
    sha256: 'remote-image-hash'
  });

  assert.equal(attempts, 1);
  assert.equal(scheduled.length, 1);

  scheduled.shift()();
  service.pollLocalClipboard();

  assert.equal(attempts, 2);
  assert.deepEqual(hub.sent, []);
});

test('ClipboardSyncService writes history selections locally without broadcasting them', () => {
  let snapshot = { contentType: 'text/plain', encoding: 'utf8', content: 'baseline', hash: 'baseline-hash' };
  const written = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => snapshot,
      writeEvent: (event) => {
        written.push(event);
        snapshot = { contentType: 'text/plain', encoding: 'utf8', content: event.content, hash: hashEventPayload(event) };
      }
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseReceive: false, pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  service.pollLocalClipboard();
  const applied = service.applyHistoryEvent({
    id: 'history-1',
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'text/plain',
    encoding: 'utf8',
    content: 'picked from history',
    sha256: 'history-hash'
  });
  service.pollLocalClipboard();

  assert.equal(applied, true);
  assert.deepEqual(
    written.map((event) => event.content),
    ['picked from history']
  );
  assert.deepEqual(hub.sent, []);
});

test('ClipboardSyncService reports unconfirmed history clipboard writes before retrying', () => {
  let retryCount = 0;
  const written = [];
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => ({ contentType: 'text/plain', encoding: 'utf8', content: 'still old', hash: 'old-hash' }),
      writeEvent: (event) => written.push(event)
    },
    hub: fakeHub(),
    settingsProvider: () => ({ deviceId: 'macbook', pauseReceive: false, pauseSend: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 }),
    setTimeout: () => {
      retryCount += 1;
      return retryCount;
    },
    clearTimeout: () => {}
  });

  const applied = service.applyHistoryEvent({
    id: 'history-1',
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'text/plain',
    encoding: 'utf8',
    content: 'picked from history',
    sha256: 'history-hash'
  });

  assert.equal(applied, false);
  assert.equal(retryCount, 1);
  assert.deepEqual(
    written.map((event) => event.content),
    ['picked from history']
  );
});

test('ClipboardSyncService removes its hub listener on stop', () => {
  const written = [];
  const hub = fakeHub();
  const service = new ClipboardSyncService({
    clipboard: {
      readSnapshot: () => null,
      writeEvent: (event) => written.push(event)
    },
    hub,
    settingsProvider: () => ({ deviceId: 'macbook', pauseReceive: false, deviceRules: {} }),
    devicesProvider: () => [],
    loopGuard: new ClipboardLoopGuard({ now: () => 1_000 })
  });

  service.start();
  service.stop();
  service.start();
  hub.emit('clipboard', {
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'text/plain',
    encoding: 'utf8',
    content: 'hello',
    sha256: 'hash'
  });
  service.stop();

  assert.equal(written.length, 1);
});
