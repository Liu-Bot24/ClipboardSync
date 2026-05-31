import assert from 'node:assert/strict';
import { test } from 'node:test';

import { menuSafeLabel } from '../src/client/menu-labels.js';

test('menuSafeLabel keeps compact labels unchanged', () => {
  assert.equal(menuSafeLabel('  连接错误   socket closed  '), '连接错误 socket closed');
});

test('menuSafeLabel truncates long native menu labels', () => {
  const label = menuSafeLabel('x'.repeat(120), 12);
  assert.equal(label, `${'x'.repeat(11)}…`);
  assert.equal(label.length, 12);
});
