import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeHubUrl } from '../src/client/settings-validation.js';

test('normalizeHubUrl accepts LAN http and trims trailing slashes', () => {
  assert.equal(normalizeHubUrl(' http://192.0.2.10:8787/// '), 'http://192.0.2.10:8787');
});

test('normalizeHubUrl adds http for bare host and port', () => {
  assert.equal(normalizeHubUrl('192.0.2.10:8787'), 'http://192.0.2.10:8787');
  assert.equal(normalizeHubUrl('nas:8787'), 'http://nas:8787');
});

test('normalizeHubUrl rejects non-http addresses', () => {
  assert.throws(() => normalizeHubUrl('ftp://192.0.2.10'), /Hub 地址/);
  assert.throws(() => normalizeHubUrl('not a url'), /Hub 地址/);
});
