import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import os from 'node:os';
import i18n from './i18n.cjs';
import { normalizeIgnoredSourcePatterns } from './source-ignore.js';

const DEFAULT_HUB_URL = '';
const DEFAULT_MAX_SEND_BYTES = 33_554_432;
export const DEFAULT_HISTORY_DISPLAY_LIMIT = 30;
const { normalizeLanguage } = i18n;

function parsePositiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(String(value || ''))) {
    throw new Error(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return number;
}

function isStaleMacLocalProxyUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.port === '18787' &&
      (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

export function normalizeHistoryDisplayLimit(value, fallback = DEFAULT_HISTORY_DISPLAY_LIMIT) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  try {
    return parsePositiveInteger(value, 'historyDisplayLimit');
  } catch {
    return fallback;
  }
}

function sanitizeDeviceId(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'device';
}

function randomDeviceIdFor(deviceName) {
  const suffix = randomUUID();
  const prefix = sanitizeDeviceId(deviceName).slice(0, 64 - suffix.length - 1) || 'device';
  return `${prefix}-${suffix}`;
}

export function defaultClientSettings(env = process.env) {
  const hostname = os.hostname();
  const deviceName = env.CLIPBOARD_CLIENT_DEVICE_NAME || hostname;
  const deviceId = env.CLIPBOARD_CLIENT_DEVICE_ID || randomDeviceIdFor(deviceName);
  return {
    hubUrl: env.CLIPBOARD_CLIENT_HUB_URL || DEFAULT_HUB_URL,
    token: env.CLIPBOARD_CLIENT_TOKEN || '',
    deviceId: sanitizeDeviceId(deviceId),
    deviceName,
    autoLaunch: true,
    pauseSend: false,
    pauseReceive: false,
    historyAlwaysOnTop: true,
    historyDisplayLimit: normalizeHistoryDisplayLimit(env.CLIPBOARD_CLIENT_HISTORY_DISPLAY_LIMIT),
    language: normalizeLanguage(env.CLIPBOARD_CLIENT_LANGUAGE),
    ignoreUnknownSource: false,
    ignoredSourcePatterns: normalizeIgnoredSourcePatterns(env.CLIPBOARD_CLIENT_IGNORED_SOURCES || ''),
    maxSendBytes: DEFAULT_MAX_SEND_BYTES,
    deviceRules: {},
    deviceRulesByIp: {}
  };
}

export class ConfigStore {
  constructor(app, options = {}) {
    this.path = options.path || join(app.getPath('userData'), 'config.json');
    this.bootstrapPaths = options.bootstrapPaths || [];
    this.settings = defaultClientSettings(options.env);
    this.createdOnLoad = false;
  }

  async load() {
    const bootstrap = await this.loadBootstrap();
    const forceBootstrapHubUrl = bootstrap.forceHubUrl === true && bootstrap.hubUrl;
    const publicPackage = bootstrap.publicPackage === true;
    let shouldSave = false;
    this.settings = {
      ...this.settings,
      ...bootstrap,
      deviceRules: bootstrap.deviceRules || this.settings.deviceRules,
      deviceRulesByIp: bootstrap.deviceRulesByIp || this.settings.deviceRulesByIp
    };

    let loadedUserConfig = false;
    try {
      const content = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(content);
      this.settings = {
        ...this.settings,
        ...parsed,
        token: parsed.token || this.settings.token,
        ignoredSourcePatterns: normalizeIgnoredSourcePatterns(parsed.ignoredSourcePatterns || this.settings.ignoredSourcePatterns),
        deviceRules: parsed.deviceRules || {},
        deviceRulesByIp: parsed.deviceRulesByIp || {}
      };
      if (forceBootstrapHubUrl) {
        this.settings.hubUrl = bootstrap.hubUrl;
      }
      if (publicPackage && this.settings.forceHubUrl === true) {
        if (isStaleMacLocalProxyUrl(this.settings.hubUrl)) {
          this.settings.hubUrl = bootstrap.hubUrl || DEFAULT_HUB_URL;
        }
        delete this.settings.forceHubUrl;
        shouldSave = true;
      }
      loadedUserConfig = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await this.backupCorruptConfig();
      }
    }
    this.createdOnLoad = !loadedUserConfig;
    if (!loadedUserConfig || bootstrap.token || shouldSave) {
      this.settings.ignoredSourcePatterns = normalizeIgnoredSourcePatterns(this.settings.ignoredSourcePatterns);
      this.settings.historyDisplayLimit = normalizeHistoryDisplayLimit(this.settings.historyDisplayLimit);
      await this.save();
    }
    this.settings.ignoredSourcePatterns = normalizeIgnoredSourcePatterns(this.settings.ignoredSourcePatterns);
    this.settings.historyDisplayLimit = normalizeHistoryDisplayLimit(this.settings.historyDisplayLimit);
    this.settings.language = normalizeLanguage(this.settings.language);
    return this.settings;
  }

  async backupCorruptConfig() {
    const backupPath = `${this.path}.broken-${Date.now()}`;
    try {
      await rename(this.path, backupPath);
      await chmod(backupPath, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async loadBootstrap() {
    for (const bootstrapPath of this.bootstrapPaths) {
      try {
        return JSON.parse(await readFile(bootstrapPath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
    return {};
  }

  get() {
    return this.settings;
  }

  wasCreatedOnLoad() {
    return this.createdOnLoad;
  }

  async update(patch) {
    const normalizedPatch = { ...patch };
    if ('ignoredSourcePatterns' in normalizedPatch) {
      normalizedPatch.ignoredSourcePatterns = normalizeIgnoredSourcePatterns(normalizedPatch.ignoredSourcePatterns);
    }
    if ('historyDisplayLimit' in normalizedPatch) {
      normalizedPatch.historyDisplayLimit = normalizeHistoryDisplayLimit(
        normalizedPatch.historyDisplayLimit,
        this.settings.historyDisplayLimit
      );
    }
    if ('language' in normalizedPatch) {
      normalizedPatch.language = normalizeLanguage(normalizedPatch.language);
    }
    this.settings = {
      ...this.settings,
      ...normalizedPatch,
      deviceRules: normalizedPatch.deviceRules || this.settings.deviceRules || {},
      deviceRulesByIp: normalizedPatch.deviceRulesByIp || this.settings.deviceRulesByIp || {}
    };
    await this.save();
    return this.settings;
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}
