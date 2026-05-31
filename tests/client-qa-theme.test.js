import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyQaThemeSource } from '../src/client/qa-theme.js';

test('applyQaThemeSource only accepts explicit QA light and dark themes', () => {
  const nativeTheme = { themeSource: 'system' };

  assert.equal(applyQaThemeSource(nativeTheme, { CLIPBOARD_SYNC_QA_THEME: 'dark' }), true);
  assert.equal(nativeTheme.themeSource, 'dark');

  assert.equal(applyQaThemeSource(nativeTheme, { CLIPBOARD_SYNC_QA_THEME: 'light' }), true);
  assert.equal(nativeTheme.themeSource, 'light');

  assert.equal(applyQaThemeSource(nativeTheme, { CLIPBOARD_SYNC_QA_THEME: 'system' }), false);
  assert.equal(nativeTheme.themeSource, 'light');
});
