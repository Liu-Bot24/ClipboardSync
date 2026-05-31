import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextPasteTargetMemory, pasteTargetMemoryAction } from '../src/client/paste-target-memory.js';

test('pasteTargetMemoryAction updates editable external targets', () => {
  assert.equal(
    pasteTargetMemoryAction({ platform: 'darwin', pid: 200, bundleId: 'com.openai.codex', canPaste: true }, { isMac: true, ownPid: 100 }),
    'update'
  );
  assert.equal(
    pasteTargetMemoryAction({ platform: 'darwin', pid: 200, bundleId: 'com.openai.codex' }, { isMac: true, ownPid: 100 }),
    'update'
  );
});

test('pasteTargetMemoryAction keeps unknown ordinary macOS app focus as the paste target', () => {
  assert.equal(
    pasteTargetMemoryAction({ platform: 'darwin', pid: 200, bundleId: 'com.brave.Browser' }, { isMac: true, ownPid: 100 }),
    'update'
  );
  assert.equal(
    pasteTargetMemoryAction({ platform: 'darwin', pid: 200, bundleId: 'com.apple.Notes', focusState: 'frontmost-only' }, { isMac: true, ownPid: 100 }),
    'update'
  );
});

test('pasteTargetMemoryAction clears Finder instead of keeping a stale paste target', () => {
  assert.equal(
    pasteTargetMemoryAction({ platform: 'darwin', pid: 200, bundleId: 'com.apple.finder' }, { isMac: true, ownPid: 100 }),
    'clear'
  );
});

test('pasteTargetMemoryAction keeps Windows ordinary frontmost windows with unknown pasteability', () => {
  assert.equal(
    pasteTargetMemoryAction({ hwnd: 12345, pid: 200, canPaste: undefined, className: 'Chrome_WidgetWin_1' }, { isWindows: true, ownPid: 100 }),
    'update'
  );
});

test('pasteTargetMemoryAction keeps remembered target when Windows shell or own app takes focus', () => {
  assert.equal(
    pasteTargetMemoryAction({ hwnd: 12345, pid: 200, className: 'Shell_TrayWnd', processName: 'explorer' }, { isWindows: true, ownPid: 100 }),
    'keep'
  );
  assert.equal(
    pasteTargetMemoryAction({ hwnd: 23456, pid: 100, className: 'Chrome_WidgetWin_1', processName: 'ClipboardSync' }, { isWindows: true, ownPid: 100 }),
    'keep'
  );
});

test('pasteTargetMemoryAction keeps remembered target when system UI takes focus', () => {
  assert.equal(
    pasteTargetMemoryAction({ platform: 'darwin', pid: 200, bundleId: 'com.apple.systemuiserver' }, { isMac: true, ownPid: 100 }),
    'keep'
  );
  assert.equal(
    pasteTargetMemoryAction({ platform: 'darwin', pid: 200, bundleId: 'dev.liuqi.clipboardsync' }, { isMac: true, ownPid: 100 }),
    'keep'
  );
});

test('nextPasteTargetMemory preserves input target through menu focus and clears explicit non-paste targets', () => {
  const remembered = nextPasteTargetMemory(
    null,
    { platform: 'darwin', pid: 200, bundleId: 'com.openai.codex' },
    { isMac: true, ownPid: 100, now: () => 1_000 }
  );
  assert.equal(remembered.bundleId, 'com.openai.codex');
  assert.equal(remembered.capturedAt, 1_000);

  assert.equal(
    nextPasteTargetMemory(
      remembered,
      { platform: 'darwin', pid: 300, bundleId: 'com.apple.systemuiserver' },
      { isMac: true, ownPid: 100, now: () => 2_000 }
    ),
    remembered
  );

  assert.equal(
    nextPasteTargetMemory(
      remembered,
      { platform: 'darwin', pid: 400, bundleId: 'com.apple.TextEdit', canPaste: false },
      { isMac: true, ownPid: 100, now: () => 3_000 }
    ),
    null
  );
});
