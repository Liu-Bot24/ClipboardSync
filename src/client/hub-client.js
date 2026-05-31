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
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  reconnectNow() {
    clearTimeout(this.reconnectTimer);
    const previous = this.ws;
    this.ws = null;
    previous?.removeAllListeners();
    previous?.close();
    this.connect();
  }

  connect() {
    const settings = this.settingsProvider();
    let wsUrl;
    try {
      wsUrl = websocketUrlFor(settings.hubUrl, settings);
    } catch (error) {
      this.emit('status', { state: 'invalid-hub-url', message: error.message });
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.ws = new this.WebSocketImpl(wsUrl, authOptions(settings.token));
    this.receiverPolicyReady = false;
    this.pendingDevices = null;
    this.pendingConfig = null;

    this.ws.on('open', () => {
      this.sendReceiverPolicy();
    });

    this.ws.on('message', (data) => {
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
        this.emit('clipboard', message);
        return;
      }
      if (message.type === 'hub.history-cleared') {
        this.emit('history-cleared');
        return;
      }
      if (message.type === 'hub.receiver-policy-updated') {
        this.handleReceiverPolicyUpdated();
        return;
      }
      if (message.type === 'error') {
        this.emit('status', { state: 'hub-error', message: message.message });
      }
    });

    this.ws.on('close', (code, reason) => {
      if (code === 4000) {
        this.emit('status', {
          state: 'duplicate-device',
          message: reason?.toString?.() || '设备 ID 重复'
        });
        return;
      }
      this.emit('status', { state: 'disconnected' });
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
      }
    });

    this.ws.on('error', (error) => {
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
    if (targetDeviceIds !== undefined) {
      payload.targetDeviceIds = targetDeviceIds;
    }

    try {
      this.ws.send(JSON.stringify(payload));
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
    try {
      this.ws.send(
        JSON.stringify({
          type: 'client.receiver-policy',
          policy: receiverPolicyFromSettings(settings)
        })
      );
      return true;
    } catch (error) {
      this.emit('status', { state: 'connection-error', message: error.message });
      return false;
    }
  }

  handleReceiverPolicyUpdated() {
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
    this.refreshDevices().catch((error) => this.emit('error', error));
    this.refreshConfig().catch((error) => this.emit('error', error));
  }

  async refreshConfig() {
    const settings = this.settingsProvider();
    const url = new URL('/v1/config', normalizeHubUrl(settings.hubUrl));
    const response = await this.fetchImpl(url, authOptions(settings.token));
    if (!response.ok) {
      throw new Error(`config request failed: ${response.status}`);
    }
    const body = await response.json();
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
    const response = await this.fetchImpl(url, authOptions(settings.token));
    if (!response.ok) {
      throw new Error(`devices request failed: ${response.status}`);
    }
    const body = await response.json();
    this.emit('devices', body.devices || []);
    return body.devices || [];
  }

  async fetchHistory(limit = 30) {
    const settings = this.settingsProvider();
    const url = new URL('/v1/history', normalizeHubUrl(settings.hubUrl));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('deviceId', settings.deviceId);
    const response = await this.fetchImpl(url, authOptions(settings.token));
    if (!response.ok) {
      throw new Error(`history request failed: ${response.status}`);
    }
    const body = await response.json();
    return body.events || [];
  }

  async clearHistory() {
    const settings = this.settingsProvider();
    const url = new URL('/v1/history', normalizeHubUrl(settings.hubUrl));
    const response = await this.fetchImpl(url, { method: 'DELETE', ...authOptions(settings.token) });
    if (!response.ok) {
      throw new Error(`clear history request failed: ${response.status}`);
    }
    return response.json();
  }
}
