import { EventEmitter } from 'node:events';
import { URL } from 'node:url';
import WebSocket from 'ws';

import { receiverPolicyFromSettings } from '../receive-policy.js';
import { normalizeHubUrl } from './settings-validation.js';

function websocketUrlFor(hubUrl, settings) {
  const url = new URL('/v1/ws', normalizeHubUrl(hubUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('deviceId', settings.deviceId);
  url.searchParams.set('deviceName', settings.deviceName);
  return url;
}

function authOptions(token) {
  return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
}

export class HubClient extends EventEmitter {
  constructor(settingsProvider, options = {}) {
    super();
    this.settingsProvider = settingsProvider;
    this.reconnectMs = options.reconnectMs ?? 2_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.ws = null;
    this.reconnectTimer = null;
    this.stopped = false;
    this.receiverPolicyReady = false;
    this.pendingDevices = null;
    this.pendingConfig = null;
    this.generation = 0;
    this.reconnectAttempts = 0;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 64 * 1024 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.requests = new Set();
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.heartbeatTimer = null;
    this.policyAckMs = options.policyAckMs ?? 2_000;
    this.policyMaxAttempts = options.policyMaxAttempts ?? 3;
    this.policyTimer = null;
    this.policyRevision = 0;
    this.pendingPolicy = null;
    this.desiredPolicy = null;
    this.acknowledgedPolicy = null;
    this.policyRevisionSupported = null;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.retireConnection();
  }

  retireConnection() {
    clearTimeout(this.policyTimer);
    this.policyTimer = null;
    this.pendingPolicy = null;
    this.desiredPolicy = null;
    this.acknowledgedPolicy = null;
    this.policyRevisionSupported = null;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.generation += 1;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    const previous = this.ws;
    this.ws = null;
    // Keep transport error listeners until the old socket has closed.
    previous?.close?.();
  }

  reconnectNow() {
    clearTimeout(this.reconnectTimer);
    this.retireConnection();
    this.reconnectAttempts = 0;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const settings = this.settingsProvider();
    let wsUrl;
    try {
      wsUrl = websocketUrlFor(settings.hubUrl, settings);
    } catch (error) {
      this.emit('status', { state: 'invalid-hub-url', message: error.message });
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.retireConnection();
    const generation = this.generation;
    const ws = this.ws = new this.WebSocketImpl(wsUrl, { ...authOptions(settings.token), handshakeTimeout: 10_000 });
    const current = () => !this.stopped && this.ws === ws && this.generation === generation;
    this.receiverPolicyReady = false;
    this.pendingDevices = null;
    this.pendingConfig = null;

    this.ws.on('open', () => {
      if (!current()) return;
      let alive = true;
      ws.on('pong', () => { alive = true; });
      this.heartbeatTimer = setInterval(() => {
        if (!current()) return;
        if (!alive) { ws.terminate?.(); return; }
        alive = false;
        try { ws.ping?.(); } catch { ws.terminate?.(); }
      }, this.heartbeatMs);
      this.heartbeatTimer.unref?.();
      this.sendReceiverPolicy();
    });

    this.ws.on('message', (data) => {
      if (!current()) return;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        this.emit('status', { state: 'hub-error', message: 'Hub 消息无效' });
        return;
      }
      if (!message || typeof message !== 'object') {
        this.emit('status', { state: 'hub-error', message: 'Hub 消息无效' });
        return;
      }
      if (message.type === 'hub.devices') {
        const devices = message.devices || [];
        if (!this.receiverPolicyReady) {
          this.pendingDevices = devices;
          return;
        }
        this.emit('devices', devices);
        return;
      }
      if (message.type === 'hub.config') {
        this.policyRevisionSupported = message.receiverPolicyRevision === true;
        const config = {
          historyDisplayLimit: message.historyDisplayLimit,
          maxHistoryEntries: message.maxHistoryEntries
        };
        if (!this.receiverPolicyReady) {
          this.pendingConfig = config;
          return;
        }
        this.emit('config', config);
        return;
      }
      if (message.type === 'clipboard.update') {
        if (typeof message.id !== 'string' || !message.id) {
          // Old Hubs used an unpersisted clipboard.update as a duplicate acknowledgement.
          if (message.sourceDeviceId === settings.deviceId) this.emit('ack', message);
          return;
        }
        this.emit('clipboard', message);
        return;
      }
      if (message.type === 'clipboard.ack') {
        this.emit('ack', message);
        return;
      }
      if (message.type === 'hub.history-cleared') {
        this.emit('history-cleared');
        return;
      }
      if (message.type === 'hub.receiver-policy-updated') {
        this.handleReceiverPolicyUpdated(message);
        return;
      }
      if (message.type === 'error') {
        this.emit('status', { state: 'hub-error', message: message.message });
      }
    });

    this.ws.on('close', (code, reason) => {
      if (!current()) return;
      this.retireConnection();
      if (code === 4000) {
        this.emit('status', {
          state: 'duplicate-device',
          message: reason?.toString?.() || '设备 ID 重复'
        });
        return;
      }
      this.emit('status', { state: 'disconnected' });
      if (!this.stopped) {
        const delay = Math.min(30_000, this.reconnectMs * 2 ** Math.min(this.reconnectAttempts++, 5));
        this.reconnectTimer = setTimeout(() => this.connect(), delay * (0.8 + Math.random() * 0.4));
      }
    });

    this.ws.on('error', (error) => {
      if (!current()) return;
      this.emit('status', { state: 'connection-error', message: error.message });
    });
  }

  sendClipboard(snapshot, targetDeviceIds) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      return false;
    }

    const payload = {
      type: 'clipboard.update',
      contentType: snapshot.contentType,
      encoding: snapshot.encoding,
      content: snapshot.content
    };
    if (snapshot.clientEventId) payload.clientEventId = snapshot.clientEventId;
    if (targetDeviceIds !== undefined) {
      payload.targetDeviceIds = targetDeviceIds;
    }

    try {
      const serialized = JSON.stringify(payload);
      if ((this.ws.bufferedAmount || 0) + Buffer.byteLength(serialized) > this.maxBufferedBytes) return false;
      this.ws.send(serialized);
      return true;
    } catch (error) {
      this.emit('status', { state: 'connection-error', message: error.message });
      return false;
    }
  }

  sendReceiverPolicy(settings = this.settingsProvider()) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      return false;
    }
    const policy = receiverPolicyFromSettings(settings);
    this.desiredPolicy = { policy, signature: JSON.stringify(policy) };
    return this.flushReceiverPolicy();
  }

  flushReceiverPolicy() {
    if (this.pendingPolicy || this.desiredPolicy.signature === this.acknowledgedPolicy) return true;
    const pending = {
      ...this.desiredPolicy,
      revision: ++this.policyRevision,
      generation: this.generation,
      ws: this.ws,
      attempts: 0
    };
    pending.message = JSON.stringify({ type: 'client.receiver-policy', policy: pending.policy, policyRevision: pending.revision });
    this.pendingPolicy = pending;
    return this.sendPolicyAttempt(pending);
  }

  sendPolicyAttempt(pending) {
    const current = () => !this.stopped && this.pendingPolicy === pending && this.ws === pending.ws && this.generation === pending.generation;
    if (!current()) return false;
    pending.attempts += 1;
    let sent = false;
    try {
      pending.ws.send(pending.message);
      sent = true;
    } catch (error) {
      this.emit('status', { state: 'connection-error', message: error.message });
    }
    clearTimeout(this.policyTimer);
    this.policyTimer = setTimeout(() => {
      if (!current()) return;
      if (this.policyRevisionSupported !== true || pending.attempts >= this.policyMaxAttempts) {
        this.emit('status', { state: 'connection-error', message: 'Hub 接收策略确认超时' });
        if (pending.ws.terminate) pending.ws.terminate();
        else pending.ws.close?.();
        return;
      }
      this.sendPolicyAttempt(pending);
    }, this.policyAckMs * 2 ** (pending.attempts - 1));
    this.policyTimer.unref?.();
    return sent;
  }

  handleReceiverPolicyUpdated(message = {}) {
    const pending = this.pendingPolicy;
    if (!pending || (message.policyRevision !== undefined && message.policyRevision !== pending.revision)) return;
    if (message.policyRevision === undefined && this.policyRevisionSupported === true) return;
    if (message.policyRevision !== undefined) this.policyRevisionSupported = true;
    clearTimeout(this.policyTimer);
    this.policyTimer = null;
    this.acknowledgedPolicy = pending.signature;
    this.pendingPolicy = null;
    if (this.desiredPolicy.signature !== this.acknowledgedPolicy) {
      this.flushReceiverPolicy();
      return;
    }
    this.reconnectAttempts = 0;
    const wasReady = this.receiverPolicyReady;
    this.receiverPolicyReady = true;
    this.emit('receiver-policy-updated');
    if (wasReady) {
      return;
    }
    this.emit('status', { state: 'connected' });
    if (this.pendingDevices) {
      this.emit('devices', this.pendingDevices);
      this.pendingDevices = null;
    }
    if (this.pendingConfig) {
      this.emit('config', this.pendingConfig);
      this.pendingConfig = null;
    }
    const generation = this.generation;
    const report = (error) => {
      if (!this.stopped && this.generation === generation && error.name !== 'AbortError') {
        this.emit('status', { state: 'hub-error', message: error.message });
      }
    };
    this.refreshDevices().catch(report);
    this.refreshConfig().catch(report);
  }

  async requestJson(url, options) {
    const generation = this.generation;
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`Hub request failed: ${response.status}`);
      const body = await response.json();
      if (controller.signal.aborted || this.stopped || generation !== this.generation) {
        throw new DOMException('Stale Hub request', 'AbortError');
      }
      return body;
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }

  async refreshConfig() {
    const settings = this.settingsProvider();
    const url = new URL('/v1/config', normalizeHubUrl(settings.hubUrl));
    const body = await this.requestJson(url, authOptions(settings.token));
    const config = {
      historyDisplayLimit: body.historyDisplayLimit,
      maxHistoryEntries: body.maxHistoryEntries
    };
    this.emit('config', config);
    return config;
  }

  async refreshDevices() {
    const settings = this.settingsProvider();
    const url = new URL('/v1/devices', normalizeHubUrl(settings.hubUrl));
    const body = await this.requestJson(url, authOptions(settings.token));
    this.emit('devices', body.devices || []);
    return body.devices || [];
  }

  async fetchHistory(limit = 30) {
    const settings = this.settingsProvider();
    const url = new URL('/v1/history', normalizeHubUrl(settings.hubUrl));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('deviceId', settings.deviceId);
    const body = await this.requestJson(url, authOptions(settings.token));
    return body.events || [];
  }

  async clearHistory() {
    const settings = this.settingsProvider();
    const url = new URL('/v1/history', normalizeHubUrl(settings.hubUrl));
    return this.requestJson(url, { method: 'DELETE', ...authOptions(settings.token) });
  }
}
