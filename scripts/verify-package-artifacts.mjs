import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractFile } from '@electron/asar';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const maxPackageEntryBytes = 512 * 1024 * 1024;
const requiredAsarEntries = [
  '/src/client/electron-main.js',
  '/src/client/preload.cjs',
  '/src/client/ui.html',
  '/src/client/ui-renderer.js',
  '/src/client/history.html',
  '/src/client/history-renderer.js',
  '/src/client/history-selection.js',
  '/src/client/direct-paste.js',
  '/src/client/clipboard-source.js',
  '/src/client/source-ignore.js',
  '/src/client/source-suggestions.js',
  '/src/client/tray-icon.png',
  '/src/client/tray-icon-win.png',
  '/src/client/config-store.js',
  '/src/client/electron-safe-storage.js',
  '/src/client/hub-client.js',
  '/src/client/mac-local-proxy.js',
  '/src/client/sync-service.js',
  '/src/client/tray-icon.js',
  '/src/client/tray-menu-template.js',
  '/src/client/policy.js',
  '/src/client/qa-theme.js',
  '/src/client/menu-labels.js',
  '/src/client/paste-target-memory.js',
  '/src/client/ui-history-event.js',
  '/src/client/startup-window-policy.js',
  '/src/client/login-item-settings.js',
  '/src/client/single-instance.js'
];

const packageTargets = [
  {
    name: 'mac',
    packageType: 'dmg',
    path: join(projectRoot, 'dist/ClipboardSync-mac-universal.dmg'),
    asarEntry: 'ClipboardSync.app/Contents/Resources/app.asar',
    configEntry: 'ClipboardSync.app/Contents/Resources/clipboard-sync.config.json',
    proxyConfigEntry: 'ClipboardSync.app/Contents/Resources/clipboard-sync.proxy.json',
    requiredEntries: [
      'Applications',
      'ClipboardSync.app/Contents/MacOS/ClipboardSync',
      'ClipboardSync.app/Contents/Resources/app.asar',
      'ClipboardSync.app/Contents/Resources/clipboard-sync.config.json',
      'ClipboardSync.app/Contents/Resources/clipboard-sync.proxy.json',
      'ClipboardSync.app/Contents/Resources/local-hub-proxy',
      'ClipboardSync.app/Contents/Resources/mac-paste-helper'
    ]
  },
  {
    name: 'windows',
    packageType: 'zip',
    path: join(projectRoot, 'dist/ClipboardSync-windows-x64.zip'),
    asarEntry: 'ClipboardSync-win32-x64/resources/app.asar',
    configEntry: 'ClipboardSync-win32-x64/clipboard-sync.config.json',
    requiredEntries: [
      'ClipboardSync-win32-x64/ClipboardSync.exe',
      'ClipboardSync-win32-x64/resources/app.asar',
      'ClipboardSync-win32-x64/clipboard-sync.config.json',
      'ClipboardSync-win32-x64/resources.pak',
      'ClipboardSync-win32-x64/icudtl.dat',
      'ClipboardSync-win32-x64/ffmpeg.dll',
      'ClipboardSync-win32-x64/libEGL.dll',
      'ClipboardSync-win32-x64/libGLESv2.dll',
      'ClipboardSync-win32-x64/snapshot_blob.bin',
      'ClipboardSync-win32-x64/v8_context_snapshot.bin',
      'ClipboardSync-win32-x64/chrome_100_percent.pak',
      'ClipboardSync-win32-x64/chrome_200_percent.pak',
      'ClipboardSync-win32-x64/d3dcompiler_47.dll',
      'ClipboardSync-win32-x64/dxcompiler.dll',
      'ClipboardSync-win32-x64/dxil.dll',
      'ClipboardSync-win32-x64/vulkan-1.dll',
      'ClipboardSync-win32-x64/vk_swiftshader.dll',
      'ClipboardSync-win32-x64/vk_swiftshader_icd.json',
      'ClipboardSync-win32-x64/locales/en-US.pak',
      'ClipboardSync-win32-x64/locales/zh-CN.pak'
    ]
  }
];

const forbiddenZipPatterns = [
  /__MACOSX/,
  /\.DS_Store/,
  /(^|\/)\._/,
  /(^|\/)\.local\//,
  /DEVELOPMENT_LOG\.md/,
  /(^|\/)\.env/,
  /(^|\/)docs\//,
  /(^|\/)tests\//,
  /(^|\/)scripts\//,
  /Dockerfile/,
  /docker-compose\.yml/
];

const forbiddenAsarPatterns = [
  /^\/tmp\//,
  /^\/\.local\//,
  /^\/docs\//,
  /^\/tests\//,
  /^\/scripts\//,
  /^\/assets\//,
  /^\/src\/server\.js$/,
  /^\/src\/index\.js$/,
  /^\/src\/config\.js$/,
  /^\/src\/event-store\.js$/,
  /^\/src\/event-validation\.js$/,
  /DEVELOPMENT_LOG\.md/,
  /(^|\/)\.env/,
  /clipboard-sync\.config\.json/
];

export function fail(message) {
  throw new Error(message);
}

function isAllowedPackageLayoutEntry(target, entry) {
  return target.name === 'mac' && target.packageType === 'dmg' && entry === '.DS_Store';
}

export function validatePackageTargetNames(targets = packageTargets) {
  const macTarget = targets.find((target) => target.name === 'mac');
  if (!macTarget || !/ClipboardSync-mac-universal\.dmg$/.test(macTarget.path)) {
    fail('Mac package must be a universal DMG');
  }
}

function zipEntries(path) {
  if (!existsSync(path)) {
    fail(`Missing package: ${path}`);
  }
  return execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function listDirectoryEntries(root, prefix = '') {
  const directory = prefix ? join(root, prefix) : root;
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(root, relativePath);
      if (lstatSync(fullPath).isDirectory()) {
        return [relativePath, ...listDirectoryEntries(root, relativePath)];
      }
      return [relativePath];
    })
    .sort();
}

function findAbsoluteSymlinks(root, prefix = '') {
  const directory = prefix ? join(root, prefix) : root;
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(root, relativePath);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(fullPath);
      return target.startsWith('/') ? [`${relativePath} -> ${target}`] : [];
    }
    if (stat.isDirectory()) {
      return findAbsoluteSymlinks(root, relativePath);
    }
    return [];
  });
}

function asarEntries(path) {
  if (!existsSync(path)) {
    fail(`Missing app.asar: ${path}`);
  }
  return execFileSync(join(projectRoot, 'node_modules/.bin/asar'), ['list', path], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function zipEntryBuffer(path, entry) {
  return execFileSync('unzip', ['-p', path, entry], { maxBuffer: maxPackageEntryBytes });
}

function mountDmg(path) {
  if (!existsSync(path)) {
    fail(`Missing package: ${path}`);
  }
  const mountPoint = mkdtempSync(join(tmpdir(), 'clipboard-dmg-mount-'));
  try {
    execFileSync('hdiutil', ['attach', path, '-nobrowse', '-readonly', '-mountpoint', mountPoint], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (error) {
    rmSync(mountPoint, { force: true, recursive: true });
    throw error;
  }
  return mountPoint;
}

function detachDmg(mountPoint) {
  try {
    execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' });
  } catch {
    execFileSync('hdiutil', ['detach', mountPoint, '-force', '-quiet'], { stdio: 'ignore' });
  } finally {
    rmSync(mountPoint, { force: true, recursive: true });
  }
}

function createPackageReader(target) {
  if (target.packageType === 'dmg') {
    const mountPoint = mountDmg(target.path);
    return {
      label: 'dmg',
      entries: listDirectoryEntries(mountPoint),
      absoluteSymlinks: findAbsoluteSymlinks(mountPoint),
      readEntry(_path, entry) {
        const fullPath = join(mountPoint, entry);
        if (lstatSync(fullPath).isDirectory()) {
          return Buffer.alloc(0);
        }
        return readFileSync(fullPath);
      },
      cleanup() {
        detachDmg(mountPoint);
      }
    };
  }

  return {
    label: 'zip',
    entries: zipEntries(target.path),
    absoluteSymlinks: [],
    readEntry: zipEntryBuffer,
    cleanup() {}
  };
}

export function withPackageReader(target, callback) {
  const reader = createPackageReader(target);
  try {
    return callback(reader);
  } finally {
    reader.cleanup();
  }
}

export function validateRequiredZipEntries(target, entries) {
  for (const requiredEntry of target.requiredEntries) {
    if (!entries.includes(requiredEntry)) {
      fail(`${target.name} package is missing ${requiredEntry}`);
    }
  }
}

export function validateForbiddenZipEntries(target, entries) {
  const forbidden = entries.filter(
    (entry) =>
      !isAllowedPackageLayoutEntry(target, entry) && forbiddenZipPatterns.some((pattern) => pattern.test(entry))
  );
  if (forbidden.length > 0) {
    fail(`${target.name} package contains forbidden entries:\n${forbidden.join('\n')}`);
  }
}

export function validateNoBrokenMacSymlinks(target, reader) {
  if (target.name !== 'mac') {
    return;
  }
  const invalid = (reader.absoluteSymlinks || []).filter((entry) => !entry.startsWith('Applications -> /Applications'));
  if (invalid.length > 0) {
    fail(`${target.name} package contains absolute app symlinks:\n${invalid.join('\n')}`);
  }
}

export function validateAsarEntries(label, entries) {
  const forbidden = entries.filter((entry) => forbiddenAsarPatterns.some((pattern) => pattern.test(entry)));
  if (forbidden.length > 0) {
    fail(`${label} contains forbidden entries:\n${forbidden.join('\n')}`);
  }
  for (const required of requiredAsarEntries) {
    if (!entries.includes(required)) {
      fail(`${label} is missing ${required}`);
    }
  }
}

export function validatePackagedConfig(label, configBytes) {
  const config = JSON.parse(configBytes.toString('utf8'));
  if (!config.hubUrl) {
    fail(`Packaged config is missing hubUrl: ${label}`);
  }
  if (
    config.token &&
    (
      typeof config.token !== 'string' ||
      config.token.length < 24 ||
      /(?:replace|change|example|test-token|token-here)/i.test(config.token)
    )
  ) {
    fail(`Packaged config contains a weak packaged token: ${label}`);
  }
  return config;
}

function shouldScanEntryForToken(entry) {
  return /\.(asar|cmd|cjs|html|js|json|mjs|ps1|txt)$/i.test(entry);
}

export function validateTokenNotLeakedOutsideConfig(target, entries, readEntry = zipEntryBuffer) {
  const config = validatePackagedConfig(`${target.name} zip:${target.configEntry}`, readEntry(target.path, target.configEntry));
  if (!config.token) {
    return config;
  }
  const token = Buffer.from(config.token, 'utf8');
  for (const entry of entries) {
    if (entry === target.configEntry || !shouldScanEntryForToken(entry)) {
      continue;
    }
    if (readEntry(target.path, entry).includes(token)) {
      fail(`${target.name} zip token leaked outside packaged config: ${entry}`);
    }
  }
  return config;
}

function isLoopbackConfigUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export function validateMacLocalProxyPackage(target, packagedConfig, readEntry = zipEntryBuffer) {
  if (packagedConfig.hubUrl !== 'http://127.0.0.1:18787') {
    fail(`Mac packaged client must connect through the bundled local proxy, got: ${packagedConfig.hubUrl}`);
  }
  if (packagedConfig.forceHubUrl !== true) {
    fail('Mac packaged client must force the local proxy hub URL over stale saved direct Hub settings');
  }

  const proxyConfig = JSON.parse(readEntry(target.path, target.proxyConfigEntry).toString('utf8'));
  if (proxyConfig.listenHost !== '127.0.0.1' || Number(proxyConfig.listenPort) !== 18787) {
    fail(`Mac proxy config must listen on 127.0.0.1:18787, got ${proxyConfig.listenHost}:${proxyConfig.listenPort}`);
  }
  if (!proxyConfig.targetUrl || isLoopbackConfigUrl(proxyConfig.targetUrl)) {
    fail(`Mac proxy config must forward to a real LAN Hub, got: ${proxyConfig.targetUrl || ''}`);
  }
}

export function validateWindowsDirectHubPackage(packagedConfig) {
  if (isLoopbackConfigUrl(packagedConfig.hubUrl)) {
    fail(`Windows packaged client must not use the Mac local proxy URL, got: ${packagedConfig.hubUrl}`);
  }
}

export function validateMacSafeStorageSwitches(label, asarPath, readAsarFile = extractFile) {
  const main = readAsarFile(asarPath, 'src/client/electron-main.js').toString('utf8');
  const helper = readAsarFile(asarPath, 'src/client/electron-safe-storage.js').toString('utf8');

  if (!main.includes('disableElectronSafeStorageKeychain(app)')) {
    fail(`${label} does not disable Electron Safe Storage on startup`);
  }
  if (!helper.includes('use-mock-keychain') || !helper.includes('password-store')) {
    fail(`${label} does not contain the macOS keychain suppression switches`);
  }
}

export function verifyPackageArtifacts({ targets = packageTargets } = {}) {
  validatePackageTargetNames(targets);
  for (const target of targets) {
    withPackageReader(target, (reader) => {
      const { entries, label, readEntry } = reader;
      validateForbiddenZipEntries(target, entries);
      validateRequiredZipEntries(target, entries);
      validateNoBrokenMacSymlinks(target, reader);

      const packagedConfig = validateTokenNotLeakedOutsideConfig(target, entries, readEntry);
      if (target.name === 'mac') {
        validateMacLocalProxyPackage(target, packagedConfig, readEntry);
      }
      if (target.name === 'windows') {
        validateWindowsDirectHubPackage(packagedConfig);
      }

      const tempDir = mkdtempSync(join(tmpdir(), `clipboard-${target.name}-asar-`));
      try {
        const asarPath = join(tempDir, 'app.asar');
        writeFileSync(asarPath, readEntry(target.path, target.asarEntry));
        validateAsarEntries(`${target.name} ${label}:${target.asarEntry}`, asarEntries(asarPath));
        if (target.name === 'mac') {
          validateMacSafeStorageSwitches(`${target.name} ${label}:${target.asarEntry}`, asarPath);
        }
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPackageArtifacts();
  console.log('package artifacts verified');
}
