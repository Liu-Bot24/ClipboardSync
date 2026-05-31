import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUiLifecycle } from '../src/client/ui-lifecycle.js';

test('UI lifecycle blocks tray and renderer updates after quit begins', () => {
  const lifecycle = createUiLifecycle();
  const tray = {};

  assert.equal(lifecycle.canBroadcast(), true);
  assert.equal(lifecycle.canUseTray(tray), true);

  lifecycle.beginQuit();

  assert.equal(lifecycle.canBroadcast(), false);
  assert.equal(lifecycle.canUseTray(tray), false);
  assert.equal(lifecycle.canUseTray(null), false);
});
