import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { normalizeHubUrl } from './settings-validation.js';

export const MAC_LOCAL_PROXY_HUB_URL = 'http://127.0.0.1:18787';

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

export function macLocalProxyTargetUrl(hubUrl) {
  if (!hubUrl) {
    return '';
  }
  const normalized = normalizeHubUrl(hubUrl);
  const url = new URL(normalized);
  if (url.protocol !== 'http:' || isLoopbackHost(url.hostname)) {
    return '';
  }
  return normalized;
}

export function hubSettingsForMacProxy(settings, proxyActive) {
  return proxyActive ? { ...settings, hubUrl: MAC_LOCAL_PROXY_HUB_URL } : settings;
}

export class MacLocalProxy {
  constructor({
    executablePath,
    configPath,
    spawnImpl = spawn,
    existsSyncImpl = existsSync,
    mkdirImpl = mkdir,
    writeFileImpl = writeFile,
    env = process.env
  }) {
    this.executablePath = executablePath;
    this.configPath = configPath;
    this.spawnImpl = spawnImpl;
    this.existsSyncImpl = existsSyncImpl;
    this.mkdirImpl = mkdirImpl;
    this.writeFileImpl = writeFileImpl;
    this.env = env;
    this.child = null;
    this.targetUrl = '';
    this.generation = 0;
    this.queue = Promise.resolve();
    this.stopping = Promise.resolve();
    this.ready = false;
  }

  isAvailable() {
    return Boolean(this.executablePath && this.existsSyncImpl(this.executablePath));
  }

  isActive() {
    return Boolean(this.ready && this.child && this.child.exitCode === null && this.targetUrl);
  }

  async ensureForHubUrl(hubUrl) {
    const generation = ++this.generation;
    const operation = this.queue.then(() => this.startForHubUrl(hubUrl, generation));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async startForHubUrl(hubUrl, generation) {
    if (generation !== this.generation) return false;
    const targetUrl = macLocalProxyTargetUrl(hubUrl);
    if (!targetUrl || !this.isAvailable()) {
      await this.stopChild();
      return false;
    }
    if (this.isActive() && this.targetUrl === targetUrl) {
      return true;
    }

    await this.stopChild();
    if (generation !== this.generation) return false;
    await this.mkdirImpl(dirname(this.configPath), { recursive: true });
    await this.writeFileImpl(
      this.configPath,
      `${JSON.stringify(
        {
          listenHost: '127.0.0.1',
          listenPort: 18787,
          targetUrl,
          targetHost: new URL(targetUrl).hostname.replace(/^\[|\]$/g, ''),
          targetPort: new URL(targetUrl).port || '80'
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    if (generation !== this.generation) return false;
    const child = this.child = this.spawnImpl(this.executablePath, [], {
      env: {
        ...this.env,
        CLIPBOARD_SYNC_PROXY_CONFIG: this.configPath
      },
      stdio: ['ignore', 'pipe', 'ignore']
    });
    this.targetUrl = targetUrl;
    const clearOwnedChild = () => {
      if (this.child !== child) return;
      this.child = null;
      this.targetUrl = '';
      this.ready = false;
    };
    child.once('exit', clearOwnedChild);
    child.on('error', clearOwnedChild);
    try {
      await new Promise((resolve, reject) => {
        let output = '';
        const cleanup = () => {
          clearTimeout(timeout);
          child.stdout?.off('data', onData);
          child.off('exit', onExit);
          child.off('error', onError);
        };
        const onData = (data) => {
          output = (output + data.toString()).slice(-1024);
          if (!output.includes('clipboard local proxy listening on ')) return;
          cleanup();
          resolve();
        };
        const onExit = () => { cleanup(); reject(new Error('local proxy exited before listening')); };
        const onError = (error) => { cleanup(); reject(error); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error('local proxy startup timed out')); }, 3_000);
        child.stdout?.on('data', onData);
        child.once('exit', onExit);
        child.once('error', onError);
      });
    } catch (error) {
      await this.stopChild();
      throw error;
    }
    if (generation !== this.generation || this.child !== child) {
      await this.stopChild();
      return false;
    }
    child.unref?.();
    child.stdout?.unref?.();
    this.ready = true;
    return true;
  }

  stop() {
    this.generation += 1;
    return this.stopChild();
  }

  stopChild() {
    const child = this.child;
    this.child = null;
    this.targetUrl = '';
    this.ready = false;
    if (!child || child.exitCode !== null) return this.stopping;
    this.stopping = new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timeout); child.off('exit', finish); resolve(); };
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        child.off('exit', finish);
        reject(new Error('local proxy did not exit within the stop timeout'));
      }, 2_000);
      child.once('exit', finish);
      child.kill();
      if (child.exitCode !== null) finish();
    });
    // Callers that intentionally stop during application exit may not await this promise.
    this.stopping.catch(() => {});
    return this.stopping;
  }
}

export class MacLocalProxyManager {
  constructor({ resourcesPath, userDataPath, ...options }) {
    this.proxy = new MacLocalProxy({
      ...options,
      executablePath: join(resourcesPath, 'local-hub-proxy'),
      configPath: join(userDataPath, 'clipboard-sync.proxy.json')
    });
  }

  async sync(settings) {
    const targetUrl = macLocalProxyTargetUrl(settings.hubUrl);
    if (!targetUrl) {
      this.proxy.stop();
      return settings;
    }
    if (!this.proxy.isAvailable()) {
      return settings;
    }
    const active = await this.proxy.ensureForHubUrl(targetUrl);
    return hubSettingsForMacProxy(settings, active);
  }

  stop() {
    this.proxy.stop();
  }
}
