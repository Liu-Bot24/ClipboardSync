import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import WebSocket from 'ws';

import { createClipboardHubServer, maxWebSocketMessageBytes, sendSocketJson } from '../src/server.js';

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-hub-server-'));
  const hub = await createClipboardHubServer({
    host: '127.0.0.1',
    port: 0,
    historyPath: join(dir, 'history.jsonl'),
    maxPayloadBytes: 1024,
    token: 'testhubtoken0123456789abcdef012345'
  });

  try {
    await hub.listen();
    const address = hub.address();
    await fn(`http://127.0.0.1:${address.port}`, `ws://127.0.0.1:${address.port}`);
  } finally {
    await hub.close();
    await rm(dir, { force: true, recursive: true });
  }
}

async function withLanServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-hub-server-'));
  const hub = await createClipboardHubServer({
    host: '127.0.0.1',
    port: 0,
    historyPath: join(dir, 'history.jsonl'),
    maxPayloadBytes: 1024,
    token: ''
  });

  try {
    await hub.listen();
    const address = hub.address();
    await fn(`http://127.0.0.1:${address.port}`, `ws://127.0.0.1:${address.port}`);
  } finally {
    await hub.close();
    await rm(dir, { force: true, recursive: true });
  }
}

function openSocket(baseUrl, deviceId, deviceName = deviceId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}/v1/ws?deviceId=${deviceId}&deviceName=${encodeURIComponent(deviceName)}`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function openLanSocket(baseUrl, deviceId, deviceName = deviceId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}/v1/ws?deviceId=${deviceId}&deviceName=${encodeURIComponent(deviceName)}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function nextMessageOfType(ws, type) {
  return new Promise((resolve) => {
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== type) {
        ws.once('message', onMessage);
        return;
      }
      resolve(message);
    };
    ws.once('message', onMessage);
  });
}

test('maxWebSocketMessageBytes leaves room for base64 JSON overhead without allowing huge frames', () => {
  assert.equal(maxWebSocketMessageBytes(1024), 67_072);
  assert.equal(maxWebSocketMessageBytes(33_554_432), 50_397_184);
});

test('sendSocketJson skips closed websockets without throwing', () => {
  const ws = {
    OPEN: 1,
    readyState: 3,
    send() {
      throw new Error('closed socket send should not happen');
    }
  };

  assert.equal(sendSocketJson(ws, { type: 'error', message: 'bad payload' }), false);
});

test('GET /health returns service status without auth', async () => {
  await withServer(async (httpBaseUrl) => {
    const response = await fetch(`${httpBaseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'clipboard-hub');
  });
});

test('GET /v1/config returns Hub client settings with auth', async () => {
  await withServer(async (httpBaseUrl) => {
    const unauthenticated = await fetch(`${httpBaseUrl}/v1/config`);
    const authenticated = await fetch(`${httpBaseUrl}/v1/config`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    });

    assert.equal(unauthenticated.status, 401);
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), {
      type: 'hub.config',
      historyDisplayLimit: 30,
      maxHistoryEntries: 100
    });
  });
});

test('LAN mode accepts history, devices, and websocket clients without auth', async () => {
  await withLanServer(async (httpBaseUrl, wsBaseUrl) => {
    const ws = await openLanSocket(wsBaseUrl, 'macbook', 'MacBook');

    const history = await fetch(`${httpBaseUrl}/v1/history?deviceId=macbook`);
    const devices = await fetch(`${httpBaseUrl}/v1/devices`);

    assert.equal(history.status, 200);
    assert.deepEqual(await history.json(), { events: [] });
    assert.equal(devices.status, 200);
    assert.equal((await devices.json()).devices.length, 1);

    ws.close();
  });
});

test('receiver policy blocks live delivery and history before content reaches the receiver', async () => {
  await withServer(async (httpBaseUrl, wsBaseUrl) => {
    const sender = await openSocket(wsBaseUrl, 'main-pc');
    const receiver = await openSocket(wsBaseUrl, 'macbook');
    const policyUpdated = nextMessageOfType(receiver, 'hub.receiver-policy-updated');

    receiver.send(
      JSON.stringify({
        type: 'client.receiver-policy',
        policy: {
          blockedSourceDeviceIds: ['main-pc']
        }
      })
    );
    await policyUpdated;

    const senderEcho = nextMessageOfType(sender, 'clipboard.update');
    const blockedMessage = nextMessageOfType(receiver, 'clipboard.update');
    sender.send(
      JSON.stringify({
        type: 'clipboard.update',
        contentType: 'text/plain',
        encoding: 'utf8',
        content: 'do not deliver to macbook'
      })
    );
    assert.equal((await senderEcho).content, 'do not deliver to macbook');

    const blockedResult = await Promise.race([
      blockedMessage.then(() => 'received'),
      new Promise((resolve) => setTimeout(() => resolve('silent'), 100))
    ]);
    assert.equal(blockedResult, 'silent');

    const headers = { Authorization: 'Bearer testhubtoken0123456789abcdef012345' };
    const receiverHistory = await fetch(`${httpBaseUrl}/v1/history?deviceId=macbook`, { headers }).then((response) =>
      response.json()
    );
    const senderHistory = await fetch(`${httpBaseUrl}/v1/history?deviceId=main-pc`, { headers }).then((response) =>
      response.json()
    );

    assert.equal(receiverHistory.events.some((event) => event.content === 'do not deliver to macbook'), false);
    assert.equal(senderHistory.events.some((event) => event.content === 'do not deliver to macbook'), true);

    sender.close();
    receiver.close();
  });
});

test('GET /v1/history uses the last confirmed receiver policy after a device disconnects', async () => {
  await withServer(async (httpBaseUrl, wsBaseUrl) => {
    const sender = await openSocket(wsBaseUrl, 'main-pc');
    const receiver = await openSocket(wsBaseUrl, 'macbook');
    const policyUpdated = nextMessageOfType(receiver, 'hub.receiver-policy-updated');

    receiver.send(
      JSON.stringify({
        type: 'client.receiver-policy',
        policy: {
          blockedSourceDeviceIds: ['main-pc']
        }
      })
    );
    await policyUpdated;
    receiver.close();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const senderEcho = nextMessageOfType(sender, 'clipboard.update');
    sender.send(
      JSON.stringify({
        type: 'clipboard.update',
        contentType: 'text/plain',
        encoding: 'utf8',
        content: 'blocked while receiver offline'
      })
    );
    assert.equal((await senderEcho).content, 'blocked while receiver offline');

    const history = await fetch(`${httpBaseUrl}/v1/history?deviceId=macbook`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    }).then((response) => response.json());

    assert.deepEqual(history.events, []);
    sender.close();
  });
});

test('GET /v1/history requires bearer auth', async () => {
  await withServer(async (httpBaseUrl) => {
    const unauthenticated = await fetch(`${httpBaseUrl}/v1/history`);
    const authenticated = await fetch(`${httpBaseUrl}/v1/history`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    });

    assert.equal(unauthenticated.status, 401);
    assert.equal(authenticated.status, 400);
    assert.deepEqual(await authenticated.json(), { error: 'invalid deviceId' });
  });
});

test('GET /v1/history rejects query-string tokens and requires a valid deviceId', async () => {
  await withServer(async (httpBaseUrl) => {
    const queryToken = await fetch(`${httpBaseUrl}/v1/history?deviceId=macbook&token=testhubtoken0123456789abcdef012345`);
    const invalidDevice = await fetch(`${httpBaseUrl}/v1/history?deviceId=bad/device`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    });
    const validDevice = await fetch(`${httpBaseUrl}/v1/history?deviceId=macbook`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    });

    assert.equal(queryToken.status, 401);
    assert.equal(invalidDevice.status, 400);
    assert.equal(validDevice.status, 200);
    assert.deepEqual(await validDevice.json(), { events: [] });
  });
});

test('WebSocket rejects token in the query string', async () => {
  await withServer(async (_httpBaseUrl, wsBaseUrl) => {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`${wsBaseUrl}/v1/ws?deviceId=macbook&token=testhubtoken0123456789abcdef012345`);
          ws.once('open', resolve);
          ws.once('error', reject);
        }),
      /Unexpected server response: 401/
    );
  });
});

test('GET /v1/devices returns connected device IP rows with auth', async () => {
  await withServer(async (httpBaseUrl, wsBaseUrl) => {
    const unauthenticated = await fetch(`${httpBaseUrl}/v1/devices`);
    assert.equal(unauthenticated.status, 401);

    const macbook = await openSocket(wsBaseUrl, 'macbook', 'MacBook');
    const pc = await openSocket(wsBaseUrl, 'main-pc', 'Main PC');

    const authenticated = await fetch(`${httpBaseUrl}/v1/devices`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    });
    const body = await authenticated.json();

    assert.equal(authenticated.status, 200);
    assert.equal(body.devices.length, 2);
    assert.deepEqual(
      body.devices.map((device) => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        ip: device.ip
      })),
      [
        { deviceId: 'macbook', deviceName: 'MacBook', ip: '127.0.0.1' },
        { deviceId: 'main-pc', deviceName: 'Main PC', ip: '127.0.0.1' }
      ]
    );

    macbook.close();
    pc.close();
  });
});

test('WebSocket broadcasts normalized clipboard updates and echoes the stored event to the sender', async () => {
  await withServer(async (_httpBaseUrl, wsBaseUrl) => {
    const sender = await openSocket(wsBaseUrl, 'main-pc');
    const receiver = await openSocket(wsBaseUrl, 'macbook');
    const senderEcho = nextMessageOfType(sender, 'clipboard.update');
    const received = nextMessageOfType(receiver, 'clipboard.update');

    sender.send(
      JSON.stringify({
        type: 'clipboard.update',
        contentType: 'text/plain',
        encoding: 'utf8',
        content: 'copied on PC'
      })
    );

    const message = await received;
    assert.equal(message.type, 'clipboard.update');
    assert.equal(message.sourceDeviceId, 'main-pc');
    assert.equal(message.content, 'copied on PC');
    assert.equal(message.sequence, 1);
    assert.equal(message.sha256.length, 64);

    const echo = await senderEcho;
    assert.equal(echo.sourceDeviceId, 'main-pc');
    assert.equal(echo.content, 'copied on PC');
    assert.equal(echo.id, message.id);

    sender.close();
    receiver.close();
  });
});

test('WebSocket acknowledges but does not broadcast adjacent duplicate clipboard updates', async () => {
  await withServer(async (httpBaseUrl, wsBaseUrl) => {
    const sender = await openSocket(wsBaseUrl, 'main-pc');
    const receiver = await openSocket(wsBaseUrl, 'macbook');
    const senderEcho = nextMessageOfType(sender, 'clipboard.update');
    const receiverMessage = nextMessageOfType(receiver, 'clipboard.update');

    const payload = {
      type: 'clipboard.update',
      contentType: 'text/plain',
      encoding: 'utf8',
      content: 'same content'
    };
    sender.send(JSON.stringify(payload));
    assert.equal((await senderEcho).content, 'same content');
    assert.equal((await receiverMessage).content, 'same content');

    const duplicateAck = nextMessageOfType(sender, 'clipboard.update');
    const duplicateReceiverMessage = nextMessageOfType(receiver, 'clipboard.update');
    sender.send(JSON.stringify(payload));

    assert.equal((await duplicateAck).content, 'same content');
    const receiverResult = await Promise.race([
      duplicateReceiverMessage.then(() => 'received'),
      new Promise((resolve) => setTimeout(() => resolve('silent'), 100))
    ]);
    assert.equal(receiverResult, 'silent');

    const history = await fetch(`${httpBaseUrl}/v1/history?deviceId=macbook`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    }).then((response) => response.json());
    assert.deepEqual(
      history.events.map((event) => event.content),
      ['same content']
    );

    sender.close();
    receiver.close();
  });
});

test('WebSocket targetDeviceIds limits broadcast recipients', async () => {
  await withServer(async (_httpBaseUrl, wsBaseUrl) => {
    const sender = await openSocket(wsBaseUrl, 'main-pc');
    const allowed = await openSocket(wsBaseUrl, 'macbook');
    const blocked = await openSocket(wsBaseUrl, 'mac-mini');
    const senderEcho = nextMessageOfType(sender, 'clipboard.update');
    const allowedMessage = nextMessageOfType(allowed, 'clipboard.update');
    const blockedMessage = nextMessageOfType(blocked, 'clipboard.update');

    sender.send(
      JSON.stringify({
        type: 'clipboard.update',
        contentType: 'text/plain',
        encoding: 'utf8',
        content: 'direct copy',
        targetDeviceIds: ['macbook']
      })
    );

    const allowedEvent = await allowedMessage;
    assert.equal(allowedEvent.content, 'direct copy');
    const echo = await senderEcho;
    assert.equal(echo.content, 'direct copy');
    assert.equal(echo.id, allowedEvent.id);
    const blockedResult = await Promise.race([
      blockedMessage.then(() => 'received'),
      new Promise((resolve) => setTimeout(() => resolve('silent'), 100))
    ]);
    assert.equal(blockedResult, 'silent');

    sender.close();
    allowed.close();
    blocked.close();
  });
});

test('WebSocket rejects too many targetDeviceIds without storing history', async () => {
  await withServer(async (httpBaseUrl, wsBaseUrl) => {
    const sender = await openSocket(wsBaseUrl, 'main-pc');
    const errorMessage = nextMessageOfType(sender, 'error');

    sender.send(
      JSON.stringify({
        type: 'clipboard.update',
        contentType: 'text/plain',
        encoding: 'utf8',
        content: 'too many targets',
        targetDeviceIds: Array.from({ length: 129 }, (_, index) => `target-${index}`)
      })
    );

    assert.match((await errorMessage).message, /targetDeviceIds exceeds 128 devices/);
    const history = await fetch(`${httpBaseUrl}/v1/history?deviceId=main-pc`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    }).then((response) => response.json());
    assert.deepEqual(history.events, []);

    sender.close();
  });
});

test('GET /v1/history filters targeted events for the requesting device', async () => {
  await withServer(async (httpBaseUrl, wsBaseUrl) => {
    const sender = await openSocket(wsBaseUrl, 'main-pc');
    const macbook = await openSocket(wsBaseUrl, 'macbook');
    const macMini = await openSocket(wsBaseUrl, 'mac-mini');
    const macbookMessage = nextMessageOfType(macbook, 'clipboard.update');

    sender.send(
      JSON.stringify({
        type: 'clipboard.update',
        contentType: 'text/plain',
        encoding: 'utf8',
        content: 'macbook history only',
        targetDeviceIds: ['macbook']
      })
    );
    assert.equal((await macbookMessage).content, 'macbook history only');

    const headers = { Authorization: 'Bearer testhubtoken0123456789abcdef012345' };
    const macbookHistory = await fetch(`${httpBaseUrl}/v1/history?deviceId=macbook`, { headers }).then((response) =>
      response.json()
    );
    const macMiniHistory = await fetch(`${httpBaseUrl}/v1/history?deviceId=mac-mini`, { headers }).then((response) =>
      response.json()
    );
    const senderHistory = await fetch(`${httpBaseUrl}/v1/history?deviceId=main-pc`, { headers }).then((response) =>
      response.json()
    );

    assert.deepEqual(
      macbookHistory.events.map((event) => event.content),
      ['macbook history only']
    );
    assert.deepEqual(macMiniHistory.events, []);
    assert.deepEqual(
      senderHistory.events.map((event) => event.content),
      ['macbook history only']
    );

    sender.close();
    macbook.close();
    macMini.close();
  });
});

test('DELETE /v1/history clears stored history and notifies connected clients', async () => {
  await withServer(async (httpBaseUrl, wsBaseUrl) => {
    const sender = await openSocket(wsBaseUrl, 'main-pc');
    const receiver = await openSocket(wsBaseUrl, 'macbook');
    const senderEcho = nextMessageOfType(sender, 'clipboard.update');
    const receiverEvent = nextMessageOfType(receiver, 'clipboard.update');

    sender.send(
      JSON.stringify({
        type: 'clipboard.update',
        contentType: 'text/plain',
        encoding: 'utf8',
        content: 'clear me'
      })
    );
    assert.equal((await senderEcho).content, 'clear me');
    assert.equal((await receiverEvent).content, 'clear me');

    const headers = { Authorization: 'Bearer testhubtoken0123456789abcdef012345' };
    const before = await fetch(`${httpBaseUrl}/v1/history?deviceId=macbook`, { headers }).then((response) =>
      response.json()
    );
    assert.deepEqual(
      before.events.map((event) => event.content),
      ['clear me']
    );

    const unauthenticated = await fetch(`${httpBaseUrl}/v1/history`, { method: 'DELETE' });
    assert.equal(unauthenticated.status, 401);

    const senderCleared = nextMessageOfType(sender, 'hub.history-cleared');
    const receiverCleared = nextMessageOfType(receiver, 'hub.history-cleared');
    const cleared = await fetch(`${httpBaseUrl}/v1/history`, { method: 'DELETE', headers });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { cleared: 1 });
    assert.deepEqual(await senderCleared, { type: 'hub.history-cleared' });
    assert.deepEqual(await receiverCleared, { type: 'hub.history-cleared' });

    const after = await fetch(`${httpBaseUrl}/v1/history?deviceId=macbook`, { headers }).then((response) =>
      response.json()
    );
    assert.deepEqual(after.events, []);

    sender.close();
    receiver.close();
  });
});

test('GET /v1/history filters by device before applying the requested limit', async () => {
  await withServer(async (httpBaseUrl, wsBaseUrl) => {
    const sender = await openSocket(wsBaseUrl, 'main-pc');
    const macbook = await openSocket(wsBaseUrl, 'macbook');
    const macMini = await openSocket(wsBaseUrl, 'mac-mini');
    const firstMacbookMessage = nextMessageOfType(macbook, 'clipboard.update');

    sender.send(
      JSON.stringify({
        type: 'clipboard.update',
        contentType: 'text/plain',
        encoding: 'utf8',
        content: 'visible older one',
        targetDeviceIds: ['macbook']
      })
    );
    assert.equal((await firstMacbookMessage).content, 'visible older one');

    const secondMacbookMessage = nextMessageOfType(macbook, 'clipboard.update');
    sender.send(
      JSON.stringify({
        type: 'clipboard.update',
        contentType: 'text/plain',
        encoding: 'utf8',
        content: 'visible older two',
        targetDeviceIds: ['macbook']
      })
    );
    assert.equal((await secondMacbookMessage).content, 'visible older two');

    for (const content of ['newer blocked one', 'newer blocked two', 'newer blocked three']) {
      sender.send(
        JSON.stringify({
          type: 'clipboard.update',
          contentType: 'text/plain',
          encoding: 'utf8',
          content,
          targetDeviceIds: ['mac-mini']
        })
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    const history = await fetch(`${httpBaseUrl}/v1/history?limit=2&deviceId=macbook`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    }).then((response) => response.json());

    assert.deepEqual(
      history.events.map((event) => event.content),
      ['visible older one', 'visible older two']
    );

    sender.close();
    macbook.close();
    macMini.close();
  });
});

test('WebSocket replaces an older connection with the same deviceId', async () => {
  await withServer(async (httpBaseUrl, wsBaseUrl) => {
    const first = await openSocket(wsBaseUrl, 'macbook');
    const closed = new Promise((resolve) => first.once('close', resolve));
    const second = await openSocket(wsBaseUrl, 'macbook');

    const devices = await fetch(`${httpBaseUrl}/v1/devices`, {
      headers: { Authorization: 'Bearer testhubtoken0123456789abcdef012345' }
    }).then((response) => response.json());
    assert.deepEqual(
      devices.devices.map((device) => device.deviceId),
      ['macbook']
    );

    await closed;
    assert.equal(first.readyState, first.CLOSED);

    second.close();
  });
});
