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
  }

  isAvailable() {
    return Boolean(this.executablePath && this.existsSyncImpl(this.executablePath));
  }

  isActive() {
    return Boolean(this.child && this.child.exitCode === null && this.targetUrl);
  }

  async ensureForHubUrl(hubUrl) {
    const targetUrl = macLocalProxyTargetUrl(hubUrl);
    if (!targetUrl || !this.isAvailable()) {
      this.stop();
      return false;
    }
    if (this.isActive() && this.targetUrl === targetUrl) {
      return true;
    }

    this.stop();
    await this.mkdirImpl(dirname(this.configPath), { recursive: true });
    await this.writeFileImpl(
      this.configPath,
      `${JSON.stringify(
        {
          listenHost: '127.0.0.1',
          listenPort: 18787,
          targetUrl
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    this.child = this.spawnImpl(this.executablePath, [], {
      env: {
        ...this.env,
        CLIPBOARD_SYNC_PROXY_CONFIG: this.configPath
      },
      stdio: 'ignore'
    });
    this.child.unref?.();
    this.child.once?.('exit', () => {
      this.child = null;
      this.targetUrl = '';
    });
    this.targetUrl = targetUrl;
    return true;
  }

  stop() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
    this.child = null;
    this.targetUrl = '';
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
    await this.proxy.ensureForHubUrl(targetUrl);
    return hubSettingsForMacProxy(settings, true);
  }

  stop() {
    this.proxy.stop();
  }
}
