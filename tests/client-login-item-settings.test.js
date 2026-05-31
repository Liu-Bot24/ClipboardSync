import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loginItemSettingsFor } from '../src/client/login-item-settings.js';

test('loginItemSettingsFor enables startup when the setting is enabled', () => {
  assert.deepEqual(loginItemSettingsFor({ autoLaunch: true, token: 'token' }, { platform: 'darwin', execPath: '/app' }), {
    openAtLogin: true
  });
  assert.deepEqual(loginItemSettingsFor({ autoLaunch: true, token: '' }, { platform: 'darwin', execPath: '/app' }), {
    openAtLogin: true
  });
});

test('loginItemSettingsFor pins the Windows startup entry to the current executable path', () => {
  assert.deepEqual(loginItemSettingsFor({ autoLaunch: true, token: 'token' }, { platform: 'win32', execPath: 'C:\\App\\ClipboardSync.exe' }), {
    openAtLogin: true,
    path: 'C:\\App\\ClipboardSync.exe'
  });
});

test('loginItemSettingsFor can disable registration during package smoke tests', () => {
  assert.deepEqual(
    loginItemSettingsFor(
      { autoLaunch: true, token: 'token' },
      { platform: 'darwin', execPath: '/app', disableAutoLaunchRegistration: true }
    ),
    {
      openAtLogin: false
    }
  );
});
