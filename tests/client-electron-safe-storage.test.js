import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  disableElectronSafeStorageKeychain,
  safeStorageKeychainSuppressionState
} from '../src/client/electron-safe-storage.js';

function fakeApp() {
  const switches = [];
  return {
    switches,
    commandLine: {
      appendSwitch(name, value) {
        switches.push([name, value]);
      },
      hasSwitch(name) {
        return switches.some(([switchName]) => switchName === name);
      },
      getSwitchValue(name) {
        return switches.find(([switchName]) => switchName === name)?.[1] || '';
      }
    }
  };
}

test('macOS startup disables Electron Safe Storage keychain prompts', () => {
  const app = fakeApp();

  disableElectronSafeStorageKeychain(app, { platform: 'darwin' });

  assert.deepEqual(app.switches, [
    ['use-mock-keychain', undefined],
    ['password-store', 'basic']
  ]);
});

test('non-macOS startup does not add macOS keychain switches', () => {
  const app = fakeApp();

  disableElectronSafeStorageKeychain(app, { platform: 'win32' });

  assert.deepEqual(app.switches, []);
});

test('safeStorageKeychainSuppressionState reports whether the macOS switches are active', () => {
  const app = fakeApp();

  assert.deepEqual(safeStorageKeychainSuppressionState(app, { platform: 'darwin' }), {
    required: true,
    enabled: false,
    mockKeychain: false,
    passwordStore: ''
  });

  disableElectronSafeStorageKeychain(app, { platform: 'darwin' });

  assert.deepEqual(safeStorageKeychainSuppressionState(app, { platform: 'darwin' }), {
    required: true,
    enabled: true,
    mockKeychain: true,
    passwordStore: 'basic'
  });
});
