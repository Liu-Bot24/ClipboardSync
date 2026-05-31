import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import {
  createClientBootstrapConfig,
  createMacProxyConfig,
  MAC_LOCAL_PROXY_HUB_URL,
  upstreamHubUrlForPackage
} from './client-bootstrap-config.mjs';

const BOOTSTRAP_NAME = 'clipboard-sync.config.json';
const PROXY_CONFIG_NAME = 'clipboard-sync.proxy.json';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const userConfigPaths = [
  join(os.homedir(), 'Library/Application Support/clipboard-hub/config.json'),
  join(os.homedir(), 'Library/Application Support/Clipboard Sync/config.json')
];

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeBootstrap(path, config) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readExistingConfig() {
  if (process.env.CLIPBOARD_CLIENT_CONFIG_PATH) {
    return readJson(process.env.CLIPBOARD_CLIENT_CONFIG_PATH);
  }
  for (const path of userConfigPaths) {
    try {
      return await readJson(path);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  throw new Error(`No client config found. Tried: ${userConfigPaths.join(', ')}`);
}

function envWithHubUrl(hubUrl) {
  return {
    ...process.env,
    CLIPBOARD_CLIENT_HUB_URL: hubUrl
  };
}

const existingConfig = await readExistingConfig();
const upstreamHubUrl = upstreamHubUrlForPackage(existingConfig);
const baseBootstrap = createClientBootstrapConfig(existingConfig, envWithHubUrl(upstreamHubUrl));
const macBootstrap = {
  ...baseBootstrap,
  hubUrl: MAC_LOCAL_PROXY_HUB_URL,
  forceHubUrl: true
};
const windowsBootstrap = {
  ...baseBootstrap,
  hubUrl: upstreamHubUrl
};
const macProxyConfig = createMacProxyConfig(existingConfig);

if (!baseBootstrap.hubUrl) {
  throw new Error('Missing hubUrl. Configure this Mac client first, or set CLIPBOARD_CLIENT_HUB_URL.');
}

const targets = [
  {
    path: join(projectRoot, 'dist/ClipboardSync-darwin-universal/ClipboardSync.app/Contents/Resources', BOOTSTRAP_NAME),
    config: macBootstrap
  },
  {
    path: join(projectRoot, 'dist/ClipboardSync-win32-x64', BOOTSTRAP_NAME),
    config: windowsBootstrap
  },
  {
    path: join(projectRoot, 'dist/ClipboardSync-darwin-universal/ClipboardSync.app/Contents/Resources', PROXY_CONFIG_NAME),
    config: macProxyConfig
  }
];

for (const target of targets) {
  await writeBootstrap(target.path, target.config);
}

console.log(`configured ${targets.length} packaged config files`);
