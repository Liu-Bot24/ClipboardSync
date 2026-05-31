import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HubClient } from '../src/client/hub-client.js';
import { EventEmitter } from 'node:events';

test('HubClient sendClipboard returns false instead of throwing when websocket send fails', () => {
  const hub = new HubClient(() => ({
    hubUrl: 'http://127.0.0.1:8787',
    token: 'token',
    deviceId: 'macbook',
    deviceName: 'MacBook'
  }));
  const statuses = [];
  hub.ws = {
    OPEN: 1,
    readyState: 1,
    send() {
      throw new Error('socket is gone');
    }
  };
  hub.on('status', (status) => statuses.push(status));

  const result = hub.sendClipboard({
    contentType: 'text/plain',
    encoding: 'utf8',
    content: 'hello'
  });

  assert.equal(result, false);
  assert.deepEqual(statuses, [{ state: 'connection-error', message: 'socket is gone' }]);
});

test('HubClient stops reconnecting when the Hub rejects a duplicate device id', async () => {
  class FakeWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.OPEN = 1;
      this.readyState = 1;
      FakeWebSocket.instances.push(this);
    }

    close() {}
  }

  const hub = new HubClient(
    () => ({
      hubUrl: 'http://127.0.0.1:8787',
      token: 'token',
      deviceId: 'macbook',
      deviceName: 'MacBook'
    }),
    { WebSocketImpl: FakeWebSocket, reconnectMs: 1 }
  );
  const statuses = [];
  hub.on('status', (status) => statuses.push(status));

  hub.start();
  FakeWebSocket.instances[0].emit('close', 4000, Buffer.from('device replaced'));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(statuses, [{ state: 'duplicate-device', message: 'device replaced' }]);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('HubClient connects in LAN mode without a token', () => {
  class FakeWebSocket extends EventEmitter {
    static instances = [];

    constructor(url, options) {
      super();
      this.OPEN = 1;
      this.readyState = 1;
      this.url = url;
      this.options = options;
      FakeWebSocket.instances.push(this);
    }

    close() {}
  }

  const hub = new HubClient(
    () => ({
      hubUrl: 'http://127.0.0.1:8787',
      token: '',
      deviceId: 'macbook',
      deviceName: 'MacBook'
    }),
    { WebSocketImpl: FakeWebSocket }
  );
  const statuses = [];
  hub.on('status', (status) => statuses.push(status));

  hub.start();

  assert.equal(statuses.length, 0);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.deepEqual(FakeWebSocket.instances[0].options, {});
});

test('HubClient sends receiver policy to the Hub', () => {
  const messages = [];
  const hub = new HubClient(() => ({
    hubUrl: 'http://127.0.0.1:8787',
    token: '',
    deviceId: 'macbook',
    deviceName: 'MacBook',
    deviceRules: {
      'main-pc': { send: true, receive: false }
    },
    deviceRulesByIp: {
      '192.0.2.30': { send: true, receive: false }
    }
  }));
  hub.ws = {
    OPEN: 1,
    readyState: 1,
    send(message) {
      messages.push(JSON.parse(message));
    }
  };

  assert.equal(hub.sendReceiverPolicy(), true);
  assert.deepEqual(messages, [
    {
      type: 'client.receiver-policy',
      policy: {
        allowedSourceDeviceIds: [],
        blockedSourceDeviceIds: ['main-pc'],
        blockedSourceIps: ['192.0.2.30']
      }
    }
  ]);
});

test('HubClient waits for receiver policy acknowledgement before reporting connected', async () => {
  class FakeWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.OPEN = 1;
      this.readyState = 1;
      this.messages = [];
      FakeWebSocket.instances.push(this);
    }

    send(message) {
      this.messages.push(JSON.parse(message));
    }

    close() {}
  }

  const calls = [];
  const hub = new HubClient(
    () => ({
      hubUrl: 'http://127.0.0.1:8787',
      token: '',
      deviceId: 'macbook',
      deviceName: 'MacBook',
      deviceRules: {
        'main-pc': { send: true, receive: false }
      }
    }),
    {
      WebSocketImpl: FakeWebSocket,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return {
          ok: true,
          json: async () => (String(url).includes('/v1/devices') ? { devices: [] } : { historyDisplayLimit: 30, maxHistoryEntries: 100 })
        };
      }
    }
  );
  const statuses = [];
  const policyEvents = [];
  hub.on('status', (status) => statuses.push(status));
  hub.on('receiver-policy-updated', () => policyEvents.push('updated'));

  hub.start();
  FakeWebSocket.instances[0].emit('open');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(FakeWebSocket.instances[0].messages, [
    {
      type: 'client.receiver-policy',
      policy: {
        allowedSourceDeviceIds: [],
        blockedSourceDeviceIds: ['main-pc'],
        blockedSourceIps: []
      }
    }
  ]);
  assert.deepEqual(statuses, []);
  assert.deepEqual(calls, []);

  FakeWebSocket.instances[0].emit('message', Buffer.from(JSON.stringify({ type: 'hub.receiver-policy-updated' })));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(policyEvents, ['updated']);
  assert.deepEqual(statuses, [{ state: 'connected' }]);
  assert.deepEqual(calls, ['http://127.0.0.1:8787/v1/devices', 'http://127.0.0.1:8787/v1/config']);
});

test('HubClient fetches Hub config with auth and emits it', async () => {
  const emitted = [];
  const calls = [];
  const hub = new HubClient(
    () => ({
      hubUrl: 'http://127.0.0.1:8787',
      token: 'secret-token',
      deviceId: 'macbook',
      deviceName: 'MacBook'
    }),
    {
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return {
          ok: true,
          json: async () => ({ type: 'hub.config', historyDisplayLimit: 30, maxHistoryEntries: 100 })
        };
      }
    }
  );
  hub.on('config', (config) => emitted.push(config));

  const config = await hub.refreshConfig();

  assert.deepEqual(config, { historyDisplayLimit: 30, maxHistoryEntries: 100 });
  assert.deepEqual(emitted, [{ historyDisplayLimit: 30, maxHistoryEntries: 100 }]);
  assert.deepEqual(calls, [
    {
      url: 'http://127.0.0.1:8787/v1/config',
      options: { headers: { Authorization: 'Bearer secret-token' } }
    }
  ]);
});

test('HubClient emits history-cleared notifications from the Hub', () => {
  class FakeWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.OPEN = 1;
      this.readyState = 1;
      FakeWebSocket.instances.push(this);
    }

    close() {}
  }

  const hub = new HubClient(
    () => ({
      hubUrl: 'http://127.0.0.1:8787',
      token: '',
      deviceId: 'macbook',
      deviceName: 'MacBook'
    }),
    { WebSocketImpl: FakeWebSocket }
  );
  const events = [];
  hub.on('history-cleared', () => events.push('cleared'));

  hub.start();
  FakeWebSocket.instances[0].emit('message', Buffer.from(JSON.stringify({ type: 'hub.history-cleared' })));

  assert.deepEqual(events, ['cleared']);
});

test('HubClient clears Hub history with the current auth settings', async () => {
  const calls = [];
  const hub = new HubClient(
    () => ({
      hubUrl: 'http://127.0.0.1:8787',
      token: 'secret-token',
      deviceId: 'macbook',
      deviceName: 'MacBook'
    }),
    {
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return {
          ok: true,
          json: async () => ({ cleared: 12 })
        };
      }
    }
  );

  const result = await hub.clearHistory();

  assert.equal(result.cleared, 12);
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/v1/history');
  assert.deepEqual(calls[0].options, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer secret-token' }
  });
});
