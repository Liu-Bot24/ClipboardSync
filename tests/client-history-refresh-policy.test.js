import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldRefreshHistoryOnStatus } from '../src/client/history-refresh-policy.js';

test('shouldRefreshHistoryOnStatus refreshes only after the Hub is connected', () => {
  assert.equal(shouldRefreshHistoryOnStatus({ state: 'connected' }), true);
  assert.equal(shouldRefreshHistoryOnStatus({ state: 'disconnected' }), false);
  assert.equal(shouldRefreshHistoryOnStatus({ state: 'connection-error' }), false);
  assert.equal(shouldRefreshHistoryOnStatus(null), false);
});
