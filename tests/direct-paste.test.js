import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isRecentPasteTarget,
  isUsablePasteTarget,
  MAC_FRONTMOST_ONLY_PASTE_TARGET_BUNDLE_IDS,
  parseMacForegroundTarget,
  parseWindowsForegroundTarget,
  pasteIntoMacTarget,
  pasteIntoWindowsTarget,
  readMacForegroundTarget,
  readWindowsForegroundTarget
} from '../src/client/direct-paste.js';

test('parseWindowsForegroundTarget parses a foreground window handle', () => {
  assert.deepEqual(parseWindowsForegroundTarget('{"hwnd":12345,"pid":6789,"canPaste":true,"className":"Chrome_WidgetWin_1","processName":"chrome"}'), {
    hwnd: 12345,
    pid: 6789,
    className: 'Chrome_WidgetWin_1',
    processName: 'chrome',
    title: '',
    canPaste: true
  });
});

test('parseWindowsForegroundTarget treats unknown UIAutomation pasteability as usable frontmost window', () => {
  const target = parseWindowsForegroundTarget('{"hwnd":12345,"pid":6789,"canPaste":null,"className":"Chrome_WidgetWin_1","processName":"chrome","title":"Docs"}');

  assert.deepEqual(target, {
    hwnd: 12345,
    pid: 6789,
    className: 'Chrome_WidgetWin_1',
    processName: 'chrome',
    title: 'Docs',
    canPaste: undefined
  });
  assert.equal(isUsablePasteTarget(target, 100), true);
});

test('isUsablePasteTarget rejects missing, own-process, invalid, and non-paste targets', () => {
  assert.equal(isUsablePasteTarget(null, 100), false);
  assert.equal(isUsablePasteTarget({ hwnd: 0, pid: 200 }, 100), false);
  assert.equal(isUsablePasteTarget({ hwnd: 12345, pid: 100 }, 100), false);
  assert.equal(isUsablePasteTarget({ hwnd: 12345, pid: 200, canPaste: false }, 100), false);
  assert.equal(isUsablePasteTarget({ hwnd: 12345, pid: 200 }, 100), true);
  assert.equal(isUsablePasteTarget({ hwnd: 12345, pid: 200, canPaste: true }, 100), true);
  assert.equal(isUsablePasteTarget({ platform: 'darwin', pid: 100, bundleId: 'com.apple.TextEdit', canPaste: true }, 100), false);
  assert.equal(isUsablePasteTarget({ platform: 'darwin', pid: 200, bundleId: 'com.apple.TextEdit', canPaste: false }, 100), false);
  assert.equal(isUsablePasteTarget({ platform: 'darwin', pid: 200, bundleId: 'com.apple.TextEdit' }, 100), true);
  assert.equal(isUsablePasteTarget({ platform: 'darwin', pid: 200, bundleId: 'com.apple.TextEdit', canPaste: true }, 100), true);
});

test('isRecentPasteTarget expires stale targets', () => {
  assert.equal(isRecentPasteTarget({ capturedAt: 1_000 }, { now: () => 20_000, ttlMs: 30_000 }), true);
  assert.equal(isRecentPasteTarget({ capturedAt: 1_000 }, { now: () => 40_001, ttlMs: 30_000 }), false);
});

test('readWindowsForegroundTarget returns parsed PowerShell target JSON', async () => {
  const calls = [];
  const target = await readWindowsForegroundTarget({
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, '{"hwnd":300,"pid":400,"canPaste":null,"className":"Chrome_WidgetWin_1","processName":"chrome","title":"Docs"}', '');
    }
  });

  assert.deepEqual(target, {
    hwnd: 300,
    pid: 400,
    className: 'Chrome_WidgetWin_1',
    processName: 'chrome',
    title: 'Docs',
    canPaste: undefined
  });
  assert.equal(calls[0].file, 'powershell.exe');
  assert.ok(calls[0].args.includes('-STA'));
  assert.match(calls[0].args.at(-1), /\$canPaste = \$null/);
  assert.doesNotMatch(calls[0].args.at(-1), /\[bool\]\$canPaste/);
  assert.match(calls[0].args.at(-1), /\$windowProcessId = 0/);
  assert.doesNotMatch(calls[0].args.at(-1), /\$pid\s*=/i);
  assert.doesNotMatch(calls[0].args.at(-1), /\[ref\]\$pid/i);
});

test('parseMacForegroundTarget parses a focused editable app target', () => {
  assert.deepEqual(
    parseMacForegroundTarget(
      '{"platform":"darwin","pid":456,"bundleId":"com.apple.TextEdit","name":"TextEdit","role":"AXTextArea","subrole":"","roleDescription":"text area","canPaste":true}'
    ),
    {
      platform: 'darwin',
      pid: 456,
      bundleId: 'com.apple.TextEdit',
      name: 'TextEdit',
      role: 'AXTextArea',
      subrole: '',
      roleDescription: 'text area',
      focusState: '',
      canPaste: true
    }
  );
  assert.equal(parseMacForegroundTarget('null'), null);
});

test('parseMacForegroundTarget keeps unknown macOS focus usable for paste attempts', () => {
  const target = parseMacForegroundTarget(
    '{"platform":"darwin","pid":73945,"bundleId":"com.openai.codex","name":"Codex","role":"","subrole":"","roleDescription":"","focusState":"missing-focused-element","canPaste":null}'
  );

  assert.deepEqual(target, {
    platform: 'darwin',
    pid: 73945,
    bundleId: 'com.openai.codex',
    name: 'Codex',
    role: '',
    subrole: '',
    roleDescription: '',
    focusState: 'missing-focused-element',
    canPaste: undefined
  });
  assert.equal(isUsablePasteTarget(target, 100), true);
});

test('parseMacForegroundTarget keeps skipped Notes focus usable for paste attempts', () => {
  const target = parseMacForegroundTarget(
    '{"platform":"darwin","pid":456,"bundleId":"com.apple.Notes","name":"Notes","role":"","subrole":"","roleDescription":"","focusState":"focus-probe-skipped","canPaste":null}'
  );

  assert.deepEqual(target, {
    platform: 'darwin',
    pid: 456,
    bundleId: 'com.apple.Notes',
    name: 'Notes',
    role: '',
    subrole: '',
    roleDescription: '',
    focusState: 'focus-probe-skipped',
    canPaste: undefined
  });
  assert.equal(isUsablePasteTarget(target, 100), true);
  assert.equal(MAC_FRONTMOST_ONLY_PASTE_TARGET_BUNDLE_IDS.has('com.apple.Notes'), true);
});

test('readMacForegroundTarget returns parsed osascript target JSON', async () => {
  const calls = [];
  const target = await readMacForegroundTarget({
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, '{"platform":"darwin","pid":456,"bundleId":"com.apple.TextEdit","canPaste":true}', '');
    }
  });

  assert.deepEqual(target, {
    platform: 'darwin',
    pid: 456,
    bundleId: 'com.apple.TextEdit',
    name: '',
    role: '',
    subrole: '',
    roleDescription: '',
    focusState: '',
    canPaste: true
  });
  assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-l', 'JavaScript']);
  assert.match(calls[0].args.at(-1), /com\.apple\.Notes/);
  assert.match(calls[0].args.at(-1), /focus-probe-skipped/);
});

test('readMacForegroundTarget returns Notes from native frontmost helper without probing AX focus', async () => {
  const previous = process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER;
  process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER = '/tmp/mac-paste-helper';
  const calls = [];
  try {
    const target = await readMacForegroundTarget({
      execFileImpl: (file, args, options, callback) => {
        calls.push({ file, args, options });
        callback(
          null,
          '{"platform":"darwin","pid":456,"bundleId":"com.apple.Notes","name":"Notes","role":"","subrole":"","roleDescription":"","focusState":"frontmost-only","canPaste":null}',
          ''
        );
      }
    });

    assert.deepEqual(target, {
      platform: 'darwin',
      pid: 456,
      bundleId: 'com.apple.Notes',
      name: 'Notes',
      role: '',
      subrole: '',
      roleDescription: '',
      focusState: 'frontmost-only',
      canPaste: undefined
    });
    assert.deepEqual(calls.map((call) => [call.file, call.args]), [['/tmp/mac-paste-helper', ['--frontmost']]]);
  } finally {
    if (previous === undefined) {
      delete process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER;
    } else {
      process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER = previous;
    }
  }
});

test('readMacForegroundTarget returns any native frontmost ordinary app without probing AX focus', async () => {
  const previous = process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER;
  process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER = '/tmp/mac-paste-helper';
  const calls = [];
  try {
    const target = await readMacForegroundTarget({
      execFileImpl: (file, args, options, callback) => {
        calls.push({ file, args, options });
        callback(
          null,
          '{"platform":"darwin","pid":456,"bundleId":"com.apple.TextEdit","name":"TextEdit","role":"","subrole":"","roleDescription":"","focusState":"frontmost-only","canPaste":null}',
          ''
        );
      }
    });

    assert.equal(target.bundleId, 'com.apple.TextEdit');
    assert.equal(target.role, '');
    assert.equal(target.focusState, 'frontmost-only');
    assert.equal(target.canPaste, undefined);
    assert.deepEqual(calls.map((call) => [call.file, call.args]), [['/tmp/mac-paste-helper', ['--frontmost']]]);
  } finally {
    if (previous === undefined) {
      delete process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER;
    } else {
      process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER = previous;
    }
  }
});

test('pasteIntoWindowsTarget focuses the target and sends Ctrl+V', async () => {
  const calls = [];
  const pasted = await pasteIntoWindowsTarget(
    { hwnd: 300, pid: 400, canPaste: true },
    {
      ownPid: 100,
      execFileImpl: (file, args, options, callback) => {
        calls.push({ file, args, options });
        callback(null, 'ok', '');
      }
    }
  );

  assert.equal(pasted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /SendWait\('\^v'\)/);
  assert.match(calls[0].args.at(-1), /300/);
});

test('pasteIntoMacTarget activates the target app and sends Command+V', async () => {
  delete process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER;
  const calls = [];
  const pasted = await pasteIntoMacTarget(
    { platform: 'darwin', pid: 456, bundleId: 'com.apple.TextEdit', canPaste: true },
    {
      ownPid: 100,
      execFileImpl: (file, args, options, callback) => {
        calls.push({ file, args, options });
        callback(null, 'ok', '');
      }
    }
  );

  assert.equal(pasted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.match(calls[0].args.at(-1), /com\.apple\.TextEdit/);
  assert.match(calls[0].args.at(-1), /keystroke\('v'/);
  assert.match(calls[0].args.at(-1), /command down/);
});

test('pasteIntoMacTarget uses bundled native helper when configured', async () => {
  const previous = process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER;
  const previousPrompt = process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER_PROMPT;
  process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER = '/tmp/mac-paste-helper';
  delete process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER_PROMPT;
  const calls = [];
  try {
    const pasted = await pasteIntoMacTarget(
      { platform: 'darwin', pid: 456, bundleId: 'com.apple.TextEdit', canPaste: true },
      {
        ownPid: 100,
        execFileImpl: (file, args, options, callback) => {
          calls.push({ file, args, options });
          callback(null, 'ok', '');
        }
      }
    );

    assert.equal(pasted, true);
    assert.deepEqual(calls.map((call) => [call.file, call.args]), [['/tmp/mac-paste-helper', ['--prompt', 'com.apple.TextEdit']]]);
  } finally {
    if (previous === undefined) {
      delete process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER;
    } else {
      process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER = previous;
    }
    if (previousPrompt === undefined) {
      delete process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER_PROMPT;
    } else {
      process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER_PROMPT = previousPrompt;
    }
  }
});

test('pasteIntoMacTarget can disable the native helper permission prompt for automation', async () => {
  const previous = process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER;
  const previousPrompt = process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER_PROMPT;
  process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER = '/tmp/mac-paste-helper';
  process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER_PROMPT = '0';
  const calls = [];
  try {
    const pasted = await pasteIntoMacTarget(
      { platform: 'darwin', pid: 456, bundleId: 'com.apple.TextEdit', canPaste: true },
      {
        ownPid: 100,
        execFileImpl: (file, args, options, callback) => {
          calls.push({ file, args, options });
          callback(null, 'ok', '');
        }
      }
    );

    assert.equal(pasted, true);
    assert.deepEqual(calls.map((call) => [call.file, call.args]), [['/tmp/mac-paste-helper', ['com.apple.TextEdit']]]);
  } finally {
    if (previous === undefined) {
      delete process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER;
    } else {
      process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER = previous;
    }
    if (previousPrompt === undefined) {
      delete process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER_PROMPT;
    } else {
      process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER_PROMPT = previousPrompt;
    }
  }
});

test('pasteIntoWindowsTarget copies only when there is no usable paste target', async () => {
  const pasted = await pasteIntoWindowsTarget(
    { hwnd: 0, pid: 400, canPaste: true },
    {
      ownPid: 100,
      execFileImpl: () => {
        throw new Error('should not run PowerShell');
      }
    }
  );

  assert.equal(pasted, false);
});
