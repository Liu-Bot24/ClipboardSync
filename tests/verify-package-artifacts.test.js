import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  validateAsarEntries,
  validateForbiddenZipEntries,
  validateMacLocalProxyPackage,
  validateMacSafeStorageSwitches,
  validatePackageTargetNames,
  validatePackagedConfig,
  validateTokenNotLeakedOutsideConfig,
  validateRequiredZipEntries,
  validateWindowsDirectHubPackage
} from '../scripts/verify-package-artifacts.mjs';

test('validateRequiredZipEntries rejects missing Windows runtime entries', () => {
  assert.throws(
    () =>
      validateRequiredZipEntries(
        {
          name: 'windows',
          requiredEntries: [
            'ClipboardSync-win32-x64/ClipboardSync.exe',
            'ClipboardSync-win32-x64/resources/app.asar'
          ]
        },
        ['ClipboardSync-win32-x64/ClipboardSync.exe']
      ),
    /windows package is missing ClipboardSync-win32-x64\/resources\/app\.asar/
  );
});

test('package artifact validation rejects local-only collaboration material', () => {
  assert.throws(
    () =>
      validateForbiddenZipEntries(
        { name: 'mac' },
        ['ClipboardSync.app/Contents/Resources/app.asar', '.local/qa/multi-device-test-checklist.md']
      ),
    /mac package contains forbidden entries/
  );

  assert.throws(
    () => validateAsarEntries('mac asar', ['/src/client/electron-main.js', '/.local/docs/internal-plan.md']),
    /mac asar contains forbidden entries/
  );
});

test('package artifact validation allows only the root Finder layout file in Mac DMGs', () => {
  assert.doesNotThrow(() =>
    validateForbiddenZipEntries(
      { name: 'mac', packageType: 'dmg' },
      ['.DS_Store', 'Applications', 'ClipboardSync.app/Contents/Resources/app.asar']
    )
  );

  assert.throws(
    () =>
      validateForbiddenZipEntries(
        { name: 'mac', packageType: 'dmg' },
        ['.DS_Store', 'ClipboardSync.app/Contents/Resources/.DS_Store']
      ),
    /mac package contains forbidden entries/
  );
});

test('validatePackageTargetNames requires a universal Mac package target', () => {
  assert.throws(
    () => validatePackageTargetNames([{ name: 'mac', path: 'dist/ClipboardSync-mac-arm64.dmg' }]),
    /Mac package must be a universal DMG/
  );
  assert.doesNotThrow(() =>
    validatePackageTargetNames([{ name: 'mac', path: 'dist/ClipboardSync-mac-universal.dmg' }])
  );
});

test('validatePackagedConfig rejects packages without a hub URL', () => {
  assert.throws(
    () => validatePackagedConfig('windows config', Buffer.from(JSON.stringify({ token: '' }))),
    /missing hubUrl/
  );
});

test('validatePackagedConfig accepts LAN packages without a token', () => {
  assert.doesNotThrow(() =>
    validatePackagedConfig('windows config', Buffer.from(JSON.stringify({ hubUrl: 'http://192.0.2.10:8787', token: '' })))
  );
});

test('validatePackagedConfig rejects placeholder or weak tokens', () => {
  assert.throws(
    () =>
      validatePackagedConfig(
        'windows config',
        Buffer.from(JSON.stringify({ hubUrl: 'http://192.0.2.10:8787', token: 'test-token' }))
      ),
    /weak packaged token/
  );
});

test('validateTokenNotLeakedOutsideConfig rejects token leaks in non-config package entries', () => {
  const target = {
    name: 'windows',
    configEntry: 'ClipboardSync-win32-x64/clipboard-sync.config.json'
  };
  const token = 'private-token-value-that-must-stay-in-config';
  const entries = [
    target.configEntry,
    'ClipboardSync-win32-x64/resources/app.asar'
  ];

  assert.throws(
    () =>
      validateTokenNotLeakedOutsideConfig(target, entries, (_path, entry) =>
        Buffer.from(
          entry === target.configEntry
            ? JSON.stringify({ hubUrl: 'http://192.0.2.10:8787', token })
            : `leaked ${token}`
        )
      ),
    /token leaked outside packaged config/
  );

  assert.doesNotThrow(() =>
    validateTokenNotLeakedOutsideConfig(target, entries, (_path, entry) =>
      Buffer.from(
        entry === target.configEntry
          ? JSON.stringify({ hubUrl: 'http://192.0.2.10:8787', token })
          : 'no secret here'
      )
    )
  );
});

test('validateMacLocalProxyPackage requires the bundled Mac local proxy shape', () => {
  const target = {
    name: 'mac',
    path: 'fake.zip',
    proxyConfigEntry: 'ClipboardSync.app/Contents/Resources/clipboard-sync.proxy.json'
  };

  assert.throws(
    () =>
      validateMacLocalProxyPackage(
        target,
        { hubUrl: 'http://192.0.2.10:8787', token: 'private-token-value-that-must-stay-in-config' },
        () => Buffer.from('{}')
      ),
    /must connect through the bundled local proxy/
  );

  assert.throws(
    () =>
      validateMacLocalProxyPackage(
        target,
        { hubUrl: 'http://127.0.0.1:18787', token: 'private-token-value-that-must-stay-in-config' },
        () =>
          Buffer.from(JSON.stringify({ listenHost: '127.0.0.1', listenPort: 18787, targetUrl: 'http://192.0.2.10:8787' }))
      ),
    /must force the local proxy hub URL/
  );

  assert.doesNotThrow(() =>
    validateMacLocalProxyPackage(
      target,
      { hubUrl: 'http://127.0.0.1:18787', forceHubUrl: true, token: 'private-token-value-that-must-stay-in-config' },
      () =>
        Buffer.from(JSON.stringify({ listenHost: '127.0.0.1', listenPort: 18787, targetUrl: 'http://192.0.2.10:8787' }))
    )
  );
});

test('validateWindowsDirectHubPackage rejects Windows packages pointed at the Mac proxy', () => {
  assert.throws(
    () => validateWindowsDirectHubPackage({ hubUrl: 'http://127.0.0.1:18787' }),
    /must not use the Mac local proxy URL/
  );

  assert.doesNotThrow(() => validateWindowsDirectHubPackage({ hubUrl: 'http://192.0.2.10:8787' }));
});

test('validateAsarEntries rejects packages missing runtime tray icon modules', () => {
  const entries = [
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
    '/src/client/mac-local-proxy.js',
    '/src/client/hub-client.js',
    '/src/client/sync-service.js',
    '/src/client/policy.js',
    '/src/client/menu-labels.js',
    '/src/client/ui-history-event.js',
    '/src/client/startup-window-policy.js',
    '/src/client/login-item-settings.js',
    '/src/client/single-instance.js'
  ];

  assert.throws(() => validateAsarEntries('mac asar', entries), /mac asar is missing \/src\/client\/tray-icon\.js/);
});

test('validateAsarEntries rejects packages missing macOS safe storage suppression module', () => {
  const entries = [
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
    '/src/client/mac-local-proxy.js',
    '/src/client/hub-client.js',
    '/src/client/sync-service.js',
    '/src/client/tray-icon.js',
    '/src/client/tray-menu-template.js',
    '/src/client/policy.js',
    '/src/client/qa-theme.js',
    '/src/client/menu-labels.js',
    '/src/client/ui-history-event.js',
    '/src/client/startup-window-policy.js',
    '/src/client/login-item-settings.js',
    '/src/client/single-instance.js'
  ];

  assert.throws(
    () => validateAsarEntries('mac asar', entries),
    /mac asar is missing \/src\/client\/electron-safe-storage\.js/
  );
});

test('validateMacSafeStorageSwitches rejects packages that can still prompt for Keychain Safe Storage', () => {
  const files = new Map([
    ['src/client/electron-main.js', 'import "./electron-safe-storage.js";\n'],
    ['src/client/electron-safe-storage.js', 'export function noop() {}\n']
  ]);

  assert.throws(
    () => validateMacSafeStorageSwitches('mac asar', 'fake.asar', (_path, entry) => Buffer.from(files.get(entry) || '')),
    /does not disable Electron Safe Storage/
  );

  files.set('src/client/electron-main.js', 'disableElectronSafeStorageKeychain(app);\n');
  assert.throws(
    () => validateMacSafeStorageSwitches('mac asar', 'fake.asar', (_path, entry) => Buffer.from(files.get(entry) || '')),
    /does not contain the macOS keychain suppression switches/
  );

  files.set(
    'src/client/electron-safe-storage.js',
    "app.commandLine.appendSwitch('use-mock-keychain');\napp.commandLine.appendSwitch('password-store', 'basic');\n"
  );
  assert.doesNotThrow(() =>
    validateMacSafeStorageSwitches('mac asar', 'fake.asar', (_path, entry) => Buffer.from(files.get(entry) || ''))
  );
});

test('validateAsarEntries rejects packages missing tray menu platform logic', () => {
  const entries = [
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
    '/src/client/mac-local-proxy.js',
    '/src/client/hub-client.js',
    '/src/client/sync-service.js',
    '/src/client/tray-icon.js',
    '/src/client/policy.js',
    '/src/client/qa-theme.js',
    '/src/client/menu-labels.js',
    '/src/client/ui-history-event.js',
    '/src/client/startup-window-policy.js',
    '/src/client/login-item-settings.js',
    '/src/client/single-instance.js'
  ];

  assert.throws(
    () => validateAsarEntries('mac asar', entries),
    /mac asar is missing \/src\/client\/tray-menu-template\.js/
  );
});
