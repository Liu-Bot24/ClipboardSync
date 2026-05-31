import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { copyAppForDmg } from '../scripts/create-mac-dmg.mjs';

test('copyAppForDmg preserves relative framework symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clipboard-dmg-copy-'));
  const sourceApp = join(root, 'Source.app');
  const framework = join(sourceApp, 'Contents/Frameworks/Electron Framework.framework');
  await mkdir(join(framework, 'Versions/A'), { recursive: true });
  await writeFile(join(framework, 'Versions/A/Electron Framework'), 'binary');
  await symlink('A', join(framework, 'Versions/Current'));
  await symlink('Versions/Current/Electron Framework', join(framework, 'Electron Framework'));

  const targetApp = join(root, 'Target.app');
  copyAppForDmg(sourceApp, targetApp);

  assert.equal(
    await readlink(join(targetApp, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')),
    'Versions/Current/Electron Framework'
  );
  assert.equal(
    await readlink(join(targetApp, 'Contents/Frameworks/Electron Framework.framework/Versions/Current')),
    'A'
  );
});
