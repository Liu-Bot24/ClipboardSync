import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hubSettingsForMacProxy,
  MAC_LOCAL_PROXY_HUB_URL,
  macLocalProxyTargetUrl,
  MacLocalProxyManager
} from '../src/client/mac-local-proxy.js';

test('macLocalProxyTargetUrl proxies LAN http hubs but not loopback or https hubs', () => {
  assert.equal(macLocalProxyTargetUrl('192.0.2.10:8787'), 'http://192.0.2.10:8787');
  assert.equal(macLocalProxyTargetUrl('http://192.0.2.10:8787/'), 'http://192.0.2.10:8787');
  assert.equal(macLocalProxyTargetUrl('http://127.0.0.1:8787'), '');
  assert.equal(macLocalProxyTargetUrl('https://hub.example.com'), '');
});

test('hubSettingsForMacProxy keeps UI settings but routes Hub calls to the local proxy', () => {
  const settings = { hubUrl: 'http://192.0.2.10:8787', token: '', deviceId: 'macbook' };

  assert.deepEqual(hubSettingsForMacProxy(settings, false), settings);
  assert.deepEqual(hubSettingsForMacProxy(settings, true), {
    ...settings,
    hubUrl: MAC_LOCAL_PROXY_HUB_URL
  });
});

test('MacLocalProxyManager writes runtime proxy config and returns local Hub settings', async () => {
  const writes = [];
  const spawned = [];
  const child = {
    exitCode: null,
    killCalled: false,
    kill() {
      this.killCalled = true;
      this.exitCode = 0;
    },
    once() {},
    unref() {}
  };
  const manager = new MacLocalProxyManager({
    resourcesPath: '/Applications/ClipboardSync.app/Contents/Resources',
    userDataPath: '/tmp/clipboard-sync-user-data',
    existsSyncImpl: () => true,
    mkdirImpl: async () => {},
    writeFileImpl: async (path, content, options) => writes.push({ path, content, options }),
    spawnImpl: (path, args, options) => {
      spawned.push({ path, args, options });
      return child;
    },
    env: { PATH: '/usr/bin' }
  });

  const settings = await manager.sync({ hubUrl: '192.0.2.10:8787', token: '', deviceId: 'macbook' });

  assert.equal(settings.hubUrl, MAC_LOCAL_PROXY_HUB_URL);
  assert.equal(spawned[0].path, '/Applications/ClipboardSync.app/Contents/Resources/local-hub-proxy');
  assert.equal(JSON.parse(writes[0].content).targetUrl, 'http://192.0.2.10:8787');
  assert.equal(spawned[0].options.env.CLIPBOARD_SYNC_PROXY_CONFIG, '/tmp/clipboard-sync-user-data/clipboard-sync.proxy.json');
  manager.stop();
  assert.equal(child.killCalled, true);
});
