import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { imageSnapshot, textSnapshot } from '../src/client/clipboard-content.js';
import { HubClient } from '../src/client/hub-client.js';
import { ClipboardLoopGuard } from '../src/client/loop-guard.js';
import { ClipboardSyncService } from '../src/client/sync-service.js';
import { createClipboardHubServer } from '../src/server.js';

class MemoryClipboard {
  constructor() {
    this.snapshot = null;
    this.written = [];
  }

  readSnapshot() {
    return this.snapshot;
  }

  writeEvent(event) {
    this.written.push(event);
    this.snapshot =
      event.contentType === 'text/plain'
        ? textSnapshot(event.content)
        : imageSnapshot(Buffer.from(event.content, 'base64'));
  }

  setText(text) {
    this.snapshot = textSnapshot(text);
  }

  setImage(bytes) {
    this.snapshot = imageSnapshot(bytes);
  }
}

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-hub-e2e-'));
  const hub = await createClipboardHubServer({
    host: '127.0.0.1',
    port: 0,
    historyPath: join(dir, 'history.jsonl'),
    maxPayloadBytes: 1024 * 1024,
    maxHistoryEntries: 100,
    historyDisplayLimit: 30,
    maxHistoryAgeMs: 60_000,
    token: 'testhubtoken0123456789abcdef012345'
  });

  try {
    await hub.listen();
    const address = hub.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await hub.close();
    await rm(dir, { force: true, recursive: true });
  }
}

function waitFor(predicate, description, timeoutMs = 1_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await predicate()) {
          resolve();
          return;
        }
      } catch {
        // Transient connection races are expected while peers are coming online.
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createPeer(hubUrl, deviceId, overrides = {}) {
  const clipboard = new MemoryClipboard();
  const settings = {
    hubUrl,
    token: 'testhubtoken0123456789abcdef012345',
    deviceId,
    deviceName: deviceId,
    pauseSend: false,
    pauseReceive: false,
    deviceRules: {},
    ...overrides
  };
  let devices = [];
  let status = { state: 'starting' };
  const events = [];
  const hub = new HubClient(() => settings, { reconnectMs: 30_000 });
  hub.on('status', (nextStatus) => {
    status = nextStatus;
  });
  hub.on('devices', (nextDevices) => {
    devices = nextDevices;
  });
  hub.on('clipboard', (event) => {
    events.push(event);
  });
  const service = new ClipboardSyncService({
    clipboard,
    hub,
    settingsProvider: () => settings,
    devicesProvider: () => devices,
    loopGuard: new ClipboardLoopGuard(),
    pollMs: 60_000
  });

  hub.start();
  service.start();

  return {
    clipboard,
    hub,
    service,
    settings,
    events,
    get devices() {
      return devices;
    },
    get status() {
      return status;
    },
    stop() {
      service.stop();
      hub.stop();
    }
  };
}

async function createPeers(hubUrl, ids) {
  const peers = ids.map((id) => createPeer(hubUrl, id));
  await waitFor(
    () => peers.every((peer) => peer.status.state === 'connected'),
    'all peers to connect'
  );
  await waitFor(
    () => peers.every((peer) => ids.every((id) => peer.devices.some((device) => device.deviceId === id))),
    'all peers to see the device list'
  );
  for (const peer of peers) {
    peer.service.pollLocalClipboard();
  }
  return peers;
}

test('two real HubClient peers sync text and images through the Hub', async () => {
  await withServer(async (hubUrl) => {
    const [pc, macbook] = await createPeers(hubUrl, ['main-pc', 'macbook']);
    try {
      pc.clipboard.setText('copied from PC');
      pc.service.pollLocalClipboard();

      await waitFor(() => macbook.clipboard.snapshot?.content === 'copied from PC', 'MacBook to receive PC text');
      assert.equal(macbook.clipboard.written.at(-1).sourceDeviceId, 'main-pc');
      assert.equal(macbook.clipboard.written.at(-1).sourceIp, '127.0.0.1');
      assert.equal(pc.events.at(-1).sourceDeviceId, 'main-pc');
      assert.equal(pc.events.at(-1).content, 'copied from PC');
      assert.deepEqual(pc.clipboard.written, []);

      const imageBytes = Buffer.from('fake-small-png-payload');
      macbook.clipboard.setImage(imageBytes);
      macbook.service.pollLocalClipboard();

      await waitFor(
        () => pc.clipboard.snapshot?.contentType === 'image/png' && pc.clipboard.snapshot.hash === imageSnapshot(imageBytes).hash,
        'PC to receive MacBook image'
      );
      assert.equal(macbook.events.at(-1).sourceDeviceId, 'macbook');
      assert.equal(macbook.events.at(-1).contentType, 'image/png');

      const history = await pc.hub.fetchHistory(10);
      assert.equal(history.length, 2);
      assert.deepEqual(
        history.map((event) => [event.sourceDeviceId, event.contentType]),
        [
          ['main-pc', 'text/plain'],
          ['macbook', 'image/png']
        ]
      );
    } finally {
      pc.stop();
      macbook.stop();
    }
  });
});

test('send and receive rules are enforced across a three-device shared clipboard', async () => {
  await withServer(async (hubUrl) => {
    const [pc, macbook, macMini] = await createPeers(hubUrl, ['main-pc', 'macbook', 'mac-mini']);
    try {
      pc.settings.deviceRules = {
        macbook: { send: true, receive: true },
        'mac-mini': { send: false, receive: true }
      };

      pc.clipboard.setText('only macbook should receive this');
      pc.service.pollLocalClipboard();

      await waitFor(
        () => macbook.clipboard.snapshot?.content === 'only macbook should receive this',
        'MacBook to receive allowed text'
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(macMini.clipboard.snapshot, null);

      macbook.settings.deviceRules = {
        'main-pc': { send: true, receive: false }
      };
      const receivePolicyUpdated = new Promise((resolve) => macbook.hub.once('receiver-policy-updated', resolve));
      macbook.hub.sendReceiverPolicy(macbook.settings);
      await receivePolicyUpdated;
      pc.clipboard.setText('blocked by MacBook receive rule');
      pc.service.pollLocalClipboard();

      await waitFor(
        async () => (await pc.hub.fetchHistory(10)).some((event) => event.content === 'blocked by MacBook receive rule'),
        'Hub history to store blocked receive event'
      );
      assert.equal(
        (await macbook.hub.fetchHistory(10)).some((event) => event.content === 'blocked by MacBook receive rule'),
        false
      );
      assert.equal(
        (await macMini.hub.fetchHistory(10)).some((event) => event.content === 'blocked by MacBook receive rule'),
        false
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(macbook.clipboard.snapshot.content, 'only macbook should receive this');
      assert.equal(macMini.clipboard.snapshot, null);
    } finally {
      pc.stop();
      macbook.stop();
      macMini.stop();
    }
  });
});

test('offline allowed targets can read targeted history after they reconnect', async () => {
  await withServer(async (hubUrl) => {
    const [pc, macMini] = await createPeers(hubUrl, ['main-pc', 'mac-mini']);
    let macbook;
    try {
      pc.settings.deviceRules = {
        macbook: { send: true, receive: true },
        'mac-mini': { send: false, receive: true }
      };

      pc.clipboard.setText('stored for offline MacBook');
      pc.service.pollLocalClipboard();

      await waitFor(
        () => pc.events.some((event) => event.content === 'stored for offline MacBook'),
        'sender to receive Hub echo for offline targeted history'
      );
      assert.equal(macMini.clipboard.snapshot, null);

      macbook = createPeer(hubUrl, 'macbook');
      await waitFor(() => macbook.status.state === 'connected', 'offline target to reconnect');

      const macbookHistory = await macbook.hub.fetchHistory(10);
      assert.equal(
        macbookHistory.some((event) => event.content === 'stored for offline MacBook'),
        true
      );
      const macMiniHistory = await macMini.hub.fetchHistory(10);
      assert.equal(
        macMiniHistory.some((event) => event.content === 'stored for offline MacBook'),
        false
      );
    } finally {
      pc.stop();
      macMini.stop();
      macbook?.stop();
    }
  });
});

test('four-device shared clipboard targets only selected receivers and hides targeted history from the rest', async () => {
  await withServer(async (hubUrl) => {
    const [macbook, mainPcInstalled, mainPcPortable, macMini, miniPc] = await createPeers(hubUrl, [
      'macbook',
      'main-pc-installed',
      'main-pc-portable',
      'mac-mini',
      'mini-pc'
    ]);
    try {
      macbook.settings.deviceRules = {
        'main-pc-installed': { send: false, receive: true },
        'main-pc-portable': { send: true, receive: true },
        'mac-mini': { send: true, receive: true },
        'mini-pc': { send: false, receive: false }
      };

      macbook.clipboard.setText('four-device targeted copy');
      macbook.service.pollLocalClipboard();

      await waitFor(
        () => mainPcPortable.clipboard.snapshot?.content === 'four-device targeted copy',
        'allowed duplicate-IP PC to receive four-device copy'
      );
      await waitFor(
        () => macMini.clipboard.snapshot?.content === 'four-device targeted copy',
        'allowed Mac mini to receive four-device copy'
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(mainPcInstalled.clipboard.snapshot, null);
      assert.equal(miniPc.clipboard.snapshot, null);

      const senderHistory = await macbook.hub.fetchHistory(10);
      const installedHistory = await mainPcInstalled.hub.fetchHistory(10);
      const portableHistory = await mainPcPortable.hub.fetchHistory(10);
      const macMiniHistory = await macMini.hub.fetchHistory(10);
      const miniPcHistory = await miniPc.hub.fetchHistory(10);

      assert.equal(senderHistory.some((event) => event.content === 'four-device targeted copy'), true);
      assert.equal(portableHistory.some((event) => event.content === 'four-device targeted copy'), true);
      assert.equal(macMiniHistory.some((event) => event.content === 'four-device targeted copy'), true);
      assert.equal(installedHistory.some((event) => event.content === 'four-device targeted copy'), false);
      assert.equal(miniPcHistory.some((event) => event.content === 'four-device targeted copy'), false);
    } finally {
      macbook.stop();
      mainPcInstalled.stop();
      mainPcPortable.stop();
      macMini.stop();
      miniPc.stop();
    }
  });
});
