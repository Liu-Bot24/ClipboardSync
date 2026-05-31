import assert from 'node:assert/strict';
import { test } from 'node:test';

import { popupActionFor, shouldHidePopupOnBlur, shouldShowInitialPopup } from '../src/client/startup-window-policy.js';

test('shouldShowInitialPopup opens the main panel on fresh desktop installs', () => {
  assert.equal(shouldShowInitialPopup({ platform: 'win32', firstRun: true }), true);
  assert.equal(shouldShowInitialPopup({ platform: 'win32', firstRun: false }), false);
  assert.equal(shouldShowInitialPopup({ platform: 'darwin', firstRun: true }), true);
  assert.equal(shouldShowInitialPopup({ platform: 'darwin', firstRun: false }), false);
  assert.equal(shouldShowInitialPopup({ platform: 'linux', firstRun: true }), false);
});

test('popupActionFor toggles normal tray clicks but keeps second-instance activation visible', () => {
  assert.equal(popupActionFor({ isVisible: false, forceShow: false }), 'show');
  assert.equal(popupActionFor({ isVisible: true, forceShow: false }), 'hide');
  assert.equal(popupActionFor({ isVisible: true, forceShow: true }), 'show');
});

test('shouldHidePopupOnBlur keeps first-run background popups visible until they have focus', () => {
  assert.equal(shouldHidePopupOnBlur({ hasFocused: false, devToolsOpened: false }), false);
  assert.equal(shouldHidePopupOnBlur({ hasFocused: true, devToolsOpened: false }), true);
  assert.equal(shouldHidePopupOnBlur({ hasFocused: true, devToolsOpened: true }), false);
});

test('shouldHidePopupOnBlur never hides the history main window on blur', () => {
  assert.equal(
    shouldHidePopupOnBlur({
      hasFocused: true,
      devToolsOpened: false,
      windowRole: 'history-main'
    }),
    false
  );
  assert.equal(
    shouldHidePopupOnBlur({
      hasFocused: true,
      devToolsOpened: false,
      windowRole: 'tray-panel'
    }),
    true
  );
});
