import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bootstrapConfigPaths } from '../src/client/bootstrap-paths.js';

test('bootstrapConfigPaths checks packaged resources, executable folder, and app root', () => {
  assert.deepEqual(
    bootstrapConfigPaths({
      resourcesPath: '/Applications/ClipboardSync.app/Contents/Resources',
      execPath: '/Applications/ClipboardSync.app/Contents/MacOS/ClipboardSync',
      appRoot: '/Applications/ClipboardSync.app/Contents/Resources/app'
    }),
    [
      '/Applications/ClipboardSync.app/Contents/Resources/clipboard-sync.config.json',
      '/Applications/ClipboardSync.app/Contents/MacOS/clipboard-sync.config.json',
      '/Applications/ClipboardSync.app/Contents/Resources/app/clipboard-sync.config.json',
      '/Applications/ClipboardSync.app/Contents/Resources/app/.client-bootstrap.json'
    ]
  );
});
