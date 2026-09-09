import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchmarkHistory } from '../scripts/benchmark-history.mjs';

test('audit: a full 100-item history no longer rewrites the window on each of 10 appends', async () => {
  const result = await benchmarkHistory();
  assert.equal(result.retained, 100);
  assert.equal(result.compactions, 0);
  assert.equal(result.logicalWriteAmplification, 1);
});

test('audit: sustained history pruning has bounded amortized write amplification', async () => {
  const result = await benchmarkHistory({ additions: 200 });
  assert.equal(result.retained, 100);
  assert.ok(result.compactions > 0 && result.compactions < 10);
  assert.ok(result.logicalWriteAmplification < 5);
});
