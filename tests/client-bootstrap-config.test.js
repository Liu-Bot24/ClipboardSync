import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createClientBootstrapConfig,
  createMacProxyConfig,
  MAC_LOCAL_PROXY_HUB_URL,
  parseOptionalBoolean,
  upstreamHubUrlForPackage
} from '../scripts/client-bootstrap-config.mjs';

test('createClientBootstrapConfig defaults new packages to auto-launch even if the builder disabled it locally', () => {
  const bootstrap = createClientBootstrapConfig({
    hubUrl: 'http://192.0.2.10:8787',
    token: 'token-from-builder',
    autoLaunch: false,
    pauseSend: true,
    pauseReceive: true,
    deviceRules: { 'main-pc': { send: false, receive: false } }
  }, {});

  assert.deepEqual(bootstrap, {
    hubUrl: 'http://192.0.2.10:8787',
    token: 'token-from-builder',
    autoLaunch: true,
    pauseSend: false,
    pauseReceive: false,
    historyAlwaysOnTop: true,
    historyDisplayLimit: 30,
    maxSendBytes: 33_554_432,
    deviceRules: {}
  });
});

test('createClientBootstrapConfig lets explicit packaging environment override hub, token, and auto-launch', () => {
  const bootstrap = createClientBootstrapConfig(
    { hubUrl: 'http://local', token: 'local-token' },
    {
      CLIPBOARD_CLIENT_HUB_URL: 'http://packaged-hub',
      CLIPBOARD_CLIENT_TOKEN: 'packaged-token',
      CLIPBOARD_CLIENT_AUTO_LAUNCH: 'false'
    }
  );

  assert.equal(bootstrap.hubUrl, 'http://packaged-hub');
  assert.equal(bootstrap.token, 'packaged-token');
  assert.equal(bootstrap.autoLaunch, false);
});

test('parseOptionalBoolean rejects ambiguous values', () => {
  assert.equal(parseOptionalBoolean(undefined, true), true);
  assert.equal(parseOptionalBoolean('off', true), false);
  assert.throws(() => parseOptionalBoolean('maybe', true), /Invalid boolean value/);
});

test('upstreamHubUrlForPackage keeps packages off the Mac local proxy unless an upstream is explicit', () => {
  assert.equal(upstreamHubUrlForPackage({ hubUrl: MAC_LOCAL_PROXY_HUB_URL }, {}), '');
  assert.equal(
    upstreamHubUrlForPackage({ hubUrl: MAC_LOCAL_PROXY_HUB_URL, upstreamHubUrl: 'http://192.0.2.50:8787' }, {}),
    'http://192.0.2.50:8787'
  );
  assert.equal(
    upstreamHubUrlForPackage(
      { hubUrl: 'http://192.0.2.10:8787' },
      { CLIPBOARD_CLIENT_UPSTREAM_HUB_URL: 'http://192.0.2.99:8787' }
    ),
    'http://192.0.2.99:8787'
  );
});

test('createMacProxyConfig writes the local listener and LAN Hub target separately', () => {
  const proxy = createMacProxyConfig({ hubUrl: MAC_LOCAL_PROXY_HUB_URL, proxyTargetUrl: 'http://192.0.2.10:8787' }, {});

  assert.deepEqual(proxy, {
    listenHost: '127.0.0.1',
    listenPort: 18787,
    targetUrl: 'http://192.0.2.10:8787'
  });
});
