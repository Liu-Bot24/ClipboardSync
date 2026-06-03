import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readConfig } from '../src/config.js';

test('readConfig allows LAN mode without a hub token', () => {
  assert.equal(readConfig({}).token, '');
});

test('readConfig rejects placeholder or weak hub tokens', () => {
  assert.throws(
    () => readConfig({ CLIPBOARD_HUB_TOKEN: 'replace-with-a-long-random-token' }),
    /real random token/
  );
  assert.throws(() => readConfig({ CLIPBOARD_HUB_TOKEN: 'short' }), /real random token/);
});

test('readConfig returns defaults with a token', () => {
  assert.deepEqual(readConfig({ CLIPBOARD_HUB_TOKEN: 'unittesttoken0123456789abcdef012345' }), {
    host: '0.0.0.0',
    port: 8787,
    historyPath: '/data/history.jsonl',
    maxPayloadBytes: 33_554_432,
    maxHistoryEntries: 100,
    historyDisplayLimit: 30,
    maxHistoryBytes: 1_073_741_824,
    maxHistoryAgeMs: 604_800_000,
    duplicateContentWindowMs: 30_000,
    token: 'unittesttoken0123456789abcdef012345'
  });
});

test('readConfig parses overrides', () => {
  assert.deepEqual(
    readConfig({
      CLIPBOARD_HUB_TOKEN: 'unittesttoken0123456789abcdef012345',
      CLIPBOARD_HUB_HOST: '127.0.0.1',
      CLIPBOARD_HUB_PORT: '9999',
      CLIPBOARD_HUB_HISTORY_PATH: '/tmp/custom.jsonl',
      CLIPBOARD_HUB_MAX_PAYLOAD_BYTES: '2048',
      CLIPBOARD_HUB_MAX_HISTORY_ENTRIES: '800',
      CLIPBOARD_HUB_HISTORY_DISPLAY_LIMIT: '40',
      CLIPBOARD_HUB_MAX_HISTORY_BYTES: '4096',
      CLIPBOARD_HUB_MAX_HISTORY_AGE_MS: '86400000',
      CLIPBOARD_HUB_DUPLICATE_CONTENT_WINDOW_MS: '5000'
    }),
    {
      host: '127.0.0.1',
      port: 9999,
      historyPath: '/tmp/custom.jsonl',
      maxPayloadBytes: 2048,
      maxHistoryEntries: 800,
      historyDisplayLimit: 40,
      maxHistoryBytes: 4096,
      maxHistoryAgeMs: 86_400_000,
      duplicateContentWindowMs: 5_000,
      token: 'unittesttoken0123456789abcdef012345'
    }
  );
});

test('readConfig allows disabling duplicate content suppression', () => {
  assert.equal(
    readConfig({
      CLIPBOARD_HUB_TOKEN: 'unittesttoken0123456789abcdef012345',
      CLIPBOARD_HUB_DUPLICATE_CONTENT_WINDOW_MS: '0'
    }).duplicateContentWindowMs,
    0
  );
});

test('readConfig rejects numeric config with trailing junk', () => {
  assert.throws(
    () =>
      readConfig({
        CLIPBOARD_HUB_TOKEN: 'unittesttoken0123456789abcdef012345',
        CLIPBOARD_HUB_PORT: '8787abc'
      }),
    /CLIPBOARD_HUB_PORT must be a positive integer/
  );
});

test('readConfig requires history byte limit to fit at least one payload', () => {
  assert.throws(
    () =>
      readConfig({
        CLIPBOARD_HUB_TOKEN: 'unittesttoken0123456789abcdef012345',
        CLIPBOARD_HUB_MAX_PAYLOAD_BYTES: '4096',
        CLIPBOARD_HUB_MAX_HISTORY_BYTES: '1024'
      }),
    /CLIPBOARD_HUB_MAX_HISTORY_BYTES must be greater than or equal to CLIPBOARD_HUB_MAX_PAYLOAD_BYTES/
  );
});
