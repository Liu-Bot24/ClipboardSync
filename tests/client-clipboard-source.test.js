import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseWindowsClipboardSource, readMacClipboardSource } from '../src/client/clipboard-source.js';

test('parseWindowsClipboardSource only returns the clipboard writer source', () => {
  const source = parseWindowsClipboardSource(
    JSON.stringify({
      ownerHwnd: 100,
      ownerPid: 200,
      processName: 'LightningDictation',
      title: 'clipboard writer',
      foregroundHwnd: 300,
      foregroundPid: 400,
      foregroundProcessName: 'Feishu',
      foregroundTitle: 'message editor'
    })
  );

  assert.equal(source.processName, 'LightningDictation');
  assert.equal('foregroundProcessName' in source, false);
  assert.equal('foregroundTitle' in source, false);
});

test('readMacClipboardSource does not report the foreground app as the clipboard writer', async () => {
  assert.equal(await readMacClipboardSource(), null);
});
