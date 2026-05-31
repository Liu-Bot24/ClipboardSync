import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeIgnoredSourcePatterns,
  sourceMatchesIgnoredPatterns,
  shouldIgnoreLocalClipboardSource
} from '../src/client/source-ignore.js';

test('normalizeIgnoredSourcePatterns accepts arrays and newline text', () => {
  assert.deepEqual(normalizeIgnoredSourcePatterns([' Voice Input ', '', 'chrome']), ['voice input', 'chrome']);
  assert.deepEqual(normalizeIgnoredSourcePatterns('Voice Input\n\nChrome.exe'), ['voice input', 'chrome.exe']);
});

test('sourceMatchesIgnoredPatterns matches process, app, bundle, and title text case-insensitively', () => {
  const source = {
    processName: 'VoiceInputHelper',
    appName: 'Dictation Bar',
    bundleId: 'com.example.Dictation',
    title: 'Recognizing speech'
  };

  assert.equal(sourceMatchesIgnoredPatterns(source, ['voiceinput']), true);
  assert.equal(sourceMatchesIgnoredPatterns(source, ['dictation bar']), true);
  assert.equal(sourceMatchesIgnoredPatterns(source, ['com.example.dictation']), true);
  assert.equal(sourceMatchesIgnoredPatterns(source, ['recognizing']), true);
  assert.equal(sourceMatchesIgnoredPatterns(source, ['photoshop']), false);
});

test('sourceMatchesIgnoredPatterns ignores foreground paste targets when matching source rules', () => {
  const source = {
    processName: 'LightningDictation',
    title: 'dictation clipboard writer',
    foregroundProcessName: 'Feishu',
    foregroundTitle: 'Feishu message editor'
  };

  assert.equal(sourceMatchesIgnoredPatterns(source, ['lightningdictation']), true);
  assert.equal(sourceMatchesIgnoredPatterns(source, ['feishu']), false);
});

test('shouldIgnoreLocalClipboardSource is disabled by default', () => {
  assert.equal(shouldIgnoreLocalClipboardSource({ processName: 'VoiceInputHelper' }, {}), false);
  assert.equal(
    shouldIgnoreLocalClipboardSource({ processName: 'VoiceInputHelper' }, { ignoredSourcePatterns: ['voiceinput'] }),
    true
  );
});

test('shouldIgnoreLocalClipboardSource treats empty owner objects as unknown sources', () => {
  const emptyWindowsOwner = {
    platform: 'win32',
    ownerHwnd: 0,
    ownerPid: 0,
    processName: '',
    title: ''
  };

  assert.equal(shouldIgnoreLocalClipboardSource(emptyWindowsOwner, { ignoreUnknownSource: true }), true);
  assert.equal(shouldIgnoreLocalClipboardSource(emptyWindowsOwner, { ignoreUnknownSource: false }), false);
});
