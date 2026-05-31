import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClipboardLoopGuard } from '../src/client/loop-guard.js';

test('ClipboardLoopGuard suppresses a recently applied remote clipboard hash once', () => {
  let now = 1_000;
  const guard = new ClipboardLoopGuard({ suppressMs: 2_000, now: () => now });

  guard.markApplied('abc');

  assert.equal(guard.shouldSuppress('abc'), true);
  assert.equal(guard.shouldSuppress('abc'), false);
});

test('ClipboardLoopGuard does not suppress different or expired hashes', () => {
  let now = 1_000;
  const guard = new ClipboardLoopGuard({ suppressMs: 2_000, now: () => now });

  guard.markApplied('abc');
  assert.equal(guard.shouldSuppress('def'), false);

  now = 4_001;
  assert.equal(guard.shouldSuppress('abc'), false);
});

test('ClipboardLoopGuard prunes expired applied hashes while marking new writes', () => {
  let now = 1_000;
  const guard = new ClipboardLoopGuard({ suppressMs: 2_000, now: () => now });

  guard.markApplied('abc');
  guard.markApplied('def');

  now = 4_001;
  guard.markApplied('ghi');

  assert.equal(guard.applied.size, 1);
  assert.equal(guard.shouldSuppress('abc'), false);
  assert.equal(guard.shouldSuppress('def'), false);
  assert.equal(guard.shouldSuppress('ghi'), true);
  assert.equal(guard.applied.size, 0);
});
