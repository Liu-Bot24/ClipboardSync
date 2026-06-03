import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { ConfigStore, defaultClientSettings } from '../src/client/config-store.js';

function fakeApp(userDataPath) {
  return {
    getPath(name) {
      assert.equal(name, 'userData');
      return userDataPath;
    }
  };
}

async function withTempConfig(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-config-store-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test('ConfigStore uses packaged bootstrap settings on first run and persists them', async () => {
  await withTempConfig(async (dir) => {
    const bootstrapPath = join(dir, 'clipboard-sync.config.json');
    await writeFile(
      bootstrapPath,
      JSON.stringify({
        hubUrl: 'http://192.0.2.10:8787',
        token: 'bootstrap-token',
        autoLaunch: true
      })
    );
    const configPath = join(dir, 'config.json');
    const store = new ConfigStore(fakeApp(dir), {
      path: configPath,
      bootstrapPaths: [bootstrapPath],
      env: {
        CLIPBOARD_CLIENT_DEVICE_ID: 'macbook',
        CLIPBOARD_CLIENT_DEVICE_NAME: 'MacBook'
      }
    });

    const settings = await store.load();

    assert.equal(settings.hubUrl, 'http://192.0.2.10:8787');
    assert.equal(settings.token, 'bootstrap-token');
    assert.equal(settings.deviceId, 'macbook');
    assert.equal(settings.deviceName, 'MacBook');
    assert.equal(settings.autoLaunch, true);
    assert.equal(settings.maxSendBytes, 33_554_432);
    assert.equal(store.wasCreatedOnLoad(), true);
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).token, 'bootstrap-token');
  });
});

test('defaultClientSettings uses the hostname as display name but not as the whole device id', () => {
  const settings = defaultClientSettings({
    CLIPBOARD_CLIENT_DEVICE_NAME: 'Desk PC'
  });

  assert.equal(settings.hubUrl, '');
  assert.equal(settings.deviceName, 'Desk PC');
  assert.match(settings.deviceId, /^Desk-PC-[0-9a-f-]{36}$/);
  assert.equal(settings.historyAlwaysOnTop, true);
  assert.equal(settings.historyDisplayLimit, 30);
  assert.equal(settings.ignoreUnknownSource, false);
  assert.equal(settings.language, 'zh-CN');
});

test('ConfigStore normalizes supported client languages', async () => {
  await withTempConfig(async (dir) => {
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ language: 'en-US' }));

    const store = new ConfigStore(fakeApp(dir), { path: configPath, bootstrapPaths: [], env: {} });
    const settings = await store.load();
    assert.equal(settings.language, 'en');

    const updated = await store.update({ language: 'fr-FR' });
    assert.equal(updated.language, 'zh-CN');
  });
});

test('defaultClientSettings can take a packaged or Hub-provided history display limit', () => {
  assert.equal(
    defaultClientSettings({
      CLIPBOARD_CLIENT_HISTORY_DISPLAY_LIMIT: '24'
    }).historyDisplayLimit,
    24
  );
  assert.equal(
    defaultClientSettings({
      CLIPBOARD_CLIENT_HISTORY_DISPLAY_LIMIT: 'bad'
    }).historyDisplayLimit,
    30
  );
});

test('defaultClientSettings keeps a random suffix when the display name is long', () => {
  const settings = defaultClientSettings({
    CLIPBOARD_CLIENT_DEVICE_NAME: 'Very Long Windows Workstation Name That Would Otherwise Eat The Random Suffix'
  });

  assert.equal(settings.deviceId.length, 64);
  assert.match(settings.deviceId, /-[0-9a-f-]{36}$/);
});

test('ConfigStore keeps user rules and fills a missing token from bootstrap', async () => {
  await withTempConfig(async (dir) => {
    const bootstrapPath = join(dir, 'clipboard-sync.config.json');
    const configPath = join(dir, 'config.json');
    await writeFile(bootstrapPath, JSON.stringify({ token: 'bootstrap-token', hubUrl: 'http://bootstrap' }));
    await writeFile(
      configPath,
      JSON.stringify({
        hubUrl: 'http://user-choice',
        token: '',
        autoLaunch: false,
        deviceRules: { 'main-pc': { send: false, receive: true } }
      })
    );

    const store = new ConfigStore(fakeApp(dir), { path: configPath, bootstrapPaths: [bootstrapPath], env: {} });
    const settings = await store.load();

    assert.equal(settings.hubUrl, 'http://user-choice');
    assert.equal(settings.token, 'bootstrap-token');
    assert.equal(settings.autoLaunch, false);
    assert.equal(store.wasCreatedOnLoad(), false);
    assert.deepEqual(settings.deviceRules, { 'main-pc': { send: false, receive: true } });
  });
});

test('ConfigStore can force packaged Mac clients through the local proxy over stale direct Hub settings', async () => {
  await withTempConfig(async (dir) => {
    const bootstrapPath = join(dir, 'clipboard-sync.config.json');
    const configPath = join(dir, 'config.json');
    await writeFile(
      bootstrapPath,
      JSON.stringify({
        token: 'bootstrap-token',
        hubUrl: 'http://127.0.0.1:18787',
        forceHubUrl: true
      })
    );
    await writeFile(
      configPath,
      JSON.stringify({
        token: 'saved-token',
        hubUrl: 'http://192.0.2.10:8787'
      })
    );

    const store = new ConfigStore(fakeApp(dir), { path: configPath, bootstrapPaths: [bootstrapPath], env: {} });
    const settings = await store.load();

    assert.equal(settings.hubUrl, 'http://127.0.0.1:18787');
    assert.equal(settings.token, 'saved-token');
    assert.equal(store.wasCreatedOnLoad(), false);
  });
});

test('ConfigStore clears stale forced local proxy settings for public packages', async () => {
  await withTempConfig(async (dir) => {
    const bootstrapPath = join(dir, 'clipboard-sync.config.json');
    const configPath = join(dir, 'config.json');
    await writeFile(
      bootstrapPath,
      JSON.stringify({
        publicPackage: true,
        hubUrl: '',
        token: ''
      })
    );
    await writeFile(
      configPath,
      JSON.stringify({
        token: 'saved-token',
        hubUrl: 'http://127.0.0.1:18787',
        forceHubUrl: true,
        autoLaunch: false
      })
    );

    const store = new ConfigStore(fakeApp(dir), { path: configPath, bootstrapPaths: [bootstrapPath], env: {} });
    const settings = await store.load();
    const saved = JSON.parse(await readFile(configPath, 'utf8'));

    assert.equal(settings.hubUrl, '');
    assert.equal(settings.token, 'saved-token');
    assert.equal(settings.forceHubUrl, undefined);
    assert.equal(settings.autoLaunch, false);
    assert.equal(saved.hubUrl, '');
    assert.equal(saved.forceHubUrl, undefined);
  });
});

test('ConfigStore keeps user-selected direct Hub settings for public packages', async () => {
  await withTempConfig(async (dir) => {
    const bootstrapPath = join(dir, 'clipboard-sync.config.json');
    const configPath = join(dir, 'config.json');
    await writeFile(bootstrapPath, JSON.stringify({ publicPackage: true, hubUrl: '', token: '' }));
    await writeFile(
      configPath,
      JSON.stringify({
        token: 'saved-token',
        hubUrl: 'http://192.0.2.10:8787'
      })
    );

    const store = new ConfigStore(fakeApp(dir), { path: configPath, bootstrapPaths: [bootstrapPath], env: {} });
    const settings = await store.load();

    assert.equal(settings.hubUrl, 'http://192.0.2.10:8787');
    assert.equal(settings.token, 'saved-token');
  });
});

test('ConfigStore tightens permissions on an existing token config file', async () => {
  await withTempConfig(async (dir) => {
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ token: 'saved-token', hubUrl: 'http://hub' }));
    await chmod(configPath, 0o644);

    const store = new ConfigStore(fakeApp(dir), { path: configPath, bootstrapPaths: [], env: {} });
    await store.load();
    await store.update({ pauseSend: true });

    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  });
});

test('ConfigStore backs up a corrupt user config and keeps the client bootable', async () => {
  await withTempConfig(async (dir) => {
    const bootstrapPath = join(dir, 'clipboard-sync.config.json');
    const configPath = join(dir, 'config.json');
    await writeFile(
      bootstrapPath,
      JSON.stringify({
        hubUrl: 'http://192.0.2.10:8787',
        token: 'bootstrap-token',
        autoLaunch: true
      })
    );
    await writeFile(configPath, '{ not valid json');
    await chmod(configPath, 0o644);

    const store = new ConfigStore(fakeApp(dir), { path: configPath, bootstrapPaths: [bootstrapPath], env: {} });
    const settings = await store.load();
    const files = await readdir(dir);
    const backupFile = files.find((file) => file.startsWith('config.json.broken-'));

    assert.equal(settings.hubUrl, 'http://192.0.2.10:8787');
    assert.equal(settings.token, 'bootstrap-token');
    assert.equal(settings.autoLaunch, true);
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).token, 'bootstrap-token');
    assert.ok(backupFile);
    assert.equal((await stat(join(dir, backupFile))).mode & 0o777, 0o600);
  });
});
