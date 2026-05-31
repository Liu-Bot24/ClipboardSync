import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { cleanPackageBuildDirs } from '../scripts/clean-package-build-dirs.mjs';

test('cleanPackageBuildDirs removes unpacked build directories and keeps deliverables', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'clipboard-clean-package-'));
  try {
    await mkdir(join(dir, 'dist', 'ClipboardSync-darwin-universal'), { recursive: true });
    await mkdir(join(dir, 'dist', 'ClipboardSync-win32-x64'), { recursive: true });
    await writeFile(join(dir, 'dist', 'ClipboardSync-mac-universal.dmg'), '');
    await writeFile(join(dir, 'dist', 'ClipboardSync-windows-x64.zip'), '');
    await writeFile(join(dir, 'dist', 'RELEASE_MANIFEST.json'), '{}');
    await writeFile(join(dir, 'dist', 'SHA256SUMS.txt'), '');

    await cleanPackageBuildDirs(dir);

    assert.deepEqual((await readdir(join(dir, 'dist'))).sort(), [
      'ClipboardSync-mac-universal.dmg',
      'ClipboardSync-windows-x64.zip',
      'RELEASE_MANIFEST.json',
      'SHA256SUMS.txt'
    ]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
