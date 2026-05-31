import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeRecentSourceSuggestions, sourceSuggestionForUi } from '../src/client/source-suggestions.js';

test('sourceSuggestionForUi prefers stable app or process names over window titles', () => {
  assert.deepEqual(
    sourceSuggestionForUi({
      processName: 'VoiceInputHelper',
      title: 'Dictation Clipboard Window'
    }),
    {
      id: 'processname:voiceinputhelper',
      label: 'VoiceInputHelper',
      pattern: 'VoiceInputHelper',
      detail: '窗口：Dictation Clipboard Window'
    }
  );

  assert.equal(sourceSuggestionForUi({ title: 'Untitled Note' }).pattern, 'Untitled Note');
});

test('sourceSuggestionForUi never suggests foreground paste targets as clipboard sources', () => {
  assert.equal(
    sourceSuggestionForUi({
      foregroundProcessName: 'Feishu',
      foregroundTitle: 'Feishu message editor'
    }).pattern,
    undefined
  );
});

test('sourceSuggestionForUi exposes unidentified copy sources as a dedicated action', () => {
  assert.deepEqual(sourceSuggestionForUi({}), {
    id: 'unknown-source',
    label: '未知复制来源',
    detail: '系统没有提供写入剪贴板的进程',
    unknown: true
  });
  assert.equal(
    sourceSuggestionForUi({
      platform: 'win32',
      ownerHwnd: 0,
      ownerPid: 0,
      processName: '',
      title: ''
    }).unknown,
    true
  );
});

test('mergeRecentSourceSuggestions dedupes sources and keeps the newest first', () => {
  const recent = mergeRecentSourceSuggestions(
    [
      {
        id: 'processname:oldapp',
        label: 'OldApp',
        pattern: 'OldApp',
        detail: ''
      }
    ],
    { processName: 'VoiceInputHelper' },
    2
  );
  const updated = mergeRecentSourceSuggestions(recent, { processName: 'OldApp', title: 'newer window' }, 2);

  assert.deepEqual(
    updated.map((item) => item.pattern),
    ['OldApp', 'VoiceInputHelper']
  );
  assert.equal(updated[0].detail, '窗口：newer window');
});
