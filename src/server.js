import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';

import { EventStore } from './event-store.js';
import { normalizeClipboardEvent, ValidationError } from './event-validation.js';
import { normalizeReceiverPolicy, receiverAllowsEvent } from './receive-policy.js';

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const DEVICE_NAME_PATTERN = /^[^\n\r\t]{1,80}$/;

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  response.end(payload);
}

function tokenFromRequest(request, url) {
  const authorization = request.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }
  return null;
}

function isAuthorized(request, url, expectedToken) {
  if (!expectedToken) {
    return true;
  }
  return tokenFromRequest(request, url) === expectedToken;
}

function parseDeviceId(url) {
  const deviceId = url.searchParams.get('deviceId');
  if (!DEVICE_ID_PATTERN.test(deviceId || '')) {
    return null;
  }
  return deviceId;
}

function parseDeviceName(url, deviceId) {
  const deviceName = url.searchParams.get('deviceName') || deviceId;
  if (!DEVICE_NAME_PATTERN.test(deviceName)) {
    return deviceId;
  }
  return deviceName;
}

function normalizeRemoteIp(address = '') {
  if (address.startsWith('::ffff:')) {
    return address.slice('::ffff:'.length);
  }
  if (address === '::1') {
    return '127.0.0.1';
  }
  return address || 'unknown';
}

function hubConfigPayload(config) {
  return {
    type: 'hub.config',
    historyDisplayLimit: config.historyDisplayLimit,
    maxHistoryEntries: config.maxHistoryEntries
  };
}

function shouldReceiveLiveEvent(peerDeviceId, event, isSender, receiverPolicy) {
  if (isSender) {
    return true;
  }
  if (!Array.isArray(event.targetDeviceIds)) {
    return receiverAllowsEvent(receiverPolicy, event, peerDeviceId);
  }
  return event.targetDeviceIds.includes(peerDeviceId) && receiverAllowsEvent(receiverPolicy, event, peerDeviceId);
}

function shouldSeeHistoryEvent(deviceId, event, receiverPolicy) {
  if (event.sourceDeviceId === deviceId) {
    return true;
  }
  if (Array.isArray(event.targetDeviceIds) && !event.targetDeviceIds.includes(deviceId)) {
    return false;
  }
  return receiverAllowsEvent(receiverPolicy, event, deviceId);
}

export function maxWebSocketMessageBytes(maxPayloadBytes) {
  return Math.ceil(maxPayloadBytes * 1.5) + 65_536;
}

export function sendSocketJson(ws, body) {
  if (ws.readyState !== ws.OPEN) {
    return false;
  }
  try {
    ws.send(JSON.stringify(body));
    return true;
  } catch {
    return false;
  }
}

export async function createClipboardHubServer(config) {
  config = {
    maxHistoryEntries: 100,
    historyDisplayLimit: 30,
    maxPayloadBytes: 33_554_432,
    ...config
  };
  const store = new EventStore(config.historyPath, {
    maxHistoryEntries: config.maxHistoryEntries,
    maxHistoryBytes: config.maxHistoryBytes,
    maxHistoryAgeMs: config.maxHistoryAgeMs
  });
  const clients = new Map();
  const clientsByDeviceId = new Map();
  const receiverPoliciesByDeviceId = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxWebSocketMessageBytes(config.maxPayloadBytes) });

  function currentDevices() {
    return [...clients.values()].map((client) => ({
      deviceId: client.deviceId,
      deviceName: client.deviceName,
      ip: client.ip,
      connectedAt: client.connectedAt
    }));
  }

  function broadcastDevices() {
    for (const peer of clients.keys()) {
      sendSocketJson(peer, { type: 'hub.devices', devices: currentDevices() });
    }
  }

  function broadcastHistoryCleared() {
    for (const peer of clients.keys()) {
      sendSocketJson(peer, { type: 'hub.history-cleared' });
    }
  }

  function receiverPolicyForDevice(deviceId) {
    const client = clients.get(clientsByDeviceId.get(deviceId));
    return client?.receiverPolicy || receiverPoliciesByDeviceId.get(deviceId) || {};
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        service: 'clipboard-hub',
        connections: clients.size
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/history') {
      if (!isAuthorized(request, url, config.token)) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const deviceId = parseDeviceId(url);
      if (!deviceId) {
        sendJson(response, 400, { error: 'invalid deviceId' });
        return;
      }
      const limit = url.searchParams.get('limit') || config.historyDisplayLimit;
      const receiverPolicy = receiverPolicyForDevice(deviceId);
      const events = store.recentWhere(limit, (event) => shouldSeeHistoryEvent(deviceId, event, receiverPolicy));
      sendJson(response, 200, { events });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/config') {
      if (!isAuthorized(request, url, config.token)) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(response, 200, hubConfigPayload(config));
      return;
    }

    if (request.method === 'DELETE' && url.pathname === '/v1/history') {
      if (!isAuthorized(request, url, config.token)) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      store.clear()
        .then((cleared) => {
          broadcastHistoryCleared();
          sendJson(response, 200, { cleared });
        })
        .catch(() => sendJson(response, 500, { error: 'internal server error' }));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/devices') {
      if (!isAuthorized(request, url, config.token)) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(response, 200, { devices: currentDevices() });
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname !== '/v1/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isAuthorized(request, url, config.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const deviceId = parseDeviceId(url);
    if (!deviceId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const deviceName = parseDeviceName(url, deviceId);
    const ip = normalizeRemoteIp(request.socket.remoteAddress);

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, { deviceId, deviceName, ip });
    });
  });

  wss.on('connection', (ws, _request, clientInfo) => {
    const existing = clientsByDeviceId.get(clientInfo.deviceId);
    if (existing && existing !== ws) {
      clients.delete(existing);
      existing.close(4000, 'device replaced');
    }

    clients.set(ws, { ...clientInfo, receiverPolicy: {}, connectedAt: new Date().toISOString() });
    clientsByDeviceId.set(clientInfo.deviceId, ws);
    sendSocketJson(ws, hubConfigPayload(config));
    broadcastDevices();

    ws.on('message', async (data) => {
      try {
        const senderInfo = clients.get(ws);
        const input = JSON.parse(data.toString());
        if (input?.type === 'client.receiver-policy') {
          const receiverPolicy = normalizeReceiverPolicy(input.policy);
          clients.set(ws, {
            ...senderInfo,
            receiverPolicy
          });
          if (senderInfo?.deviceId) {
            receiverPoliciesByDeviceId.set(senderInfo.deviceId, receiverPolicy);
          }
          sendSocketJson(ws, { type: 'hub.receiver-policy-updated' });
          return;
        }
        const normalized = normalizeClipboardEvent(input, {
          maxPayloadBytes: config.maxPayloadBytes,
          sourceDeviceId: senderInfo.deviceId
        });
        const stored = await store.append({ ...normalized, sourceIp: senderInfo.ip });
        if (!stored) {
          sendSocketJson(ws, { ...normalized, sourceIp: senderInfo.ip });
          return;
        }

        for (const [peer, peerInfo] of clients.entries()) {
          if (
            peer.readyState !== peer.OPEN ||
            !shouldReceiveLiveEvent(peerInfo.deviceId, stored, peer === ws, peerInfo.receiverPolicy)
          ) {
            continue;
          }
          sendSocketJson(peer, stored);
        }
      } catch (error) {
        const message =
          error instanceof SyntaxError || error instanceof ValidationError
            ? error.message
            : 'internal server error';
        sendSocketJson(ws, { type: 'error', message });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (clientsByDeviceId.get(clientInfo.deviceId) === ws) {
        clientsByDeviceId.delete(clientInfo.deviceId);
      }
      broadcastDevices();
    });
  });

  return {
    async listen() {
      await store.ready();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      });
    },
    address() {
      return server.address();
    },
    async close() {
      for (const client of clients.keys()) {
        client.close();
      }
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      wss.close();
    }
  };
}
