import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { sha256File } from '../scripts/write-release-manifest.mjs';
import { verifyReleaseManifest } from '../scripts/verify-release-manifest.mjs';

async function writeReleaseFixture(root, overrides = {}) {
  const packagePath = join(root, 'dist/ClipboardSync-mac-universal.dmg');
  const manifestPath = join(root, 'dist/RELEASE_MANIFEST.json');
  const sha256Path = join(root, 'dist/SHA256SUMS.txt');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(packagePath, overrides.packageBytes || 'package-bytes');
  const sha256 = await sha256File(packagePath);
  const bytes = Buffer.byteLength(overrides.packageBytes || 'package-bytes');
  const manifest = {
    project: 'clipboard-hub',
    version: '0.1.0',
    privatePackage: true,
    generatedAt: '2026-06-01T00:00:00.000Z',
    gitCommit: overrides.gitCommit || 'abc1234',
    packages: [
      {
        name: 'mac-universal',
        platform: 'darwin-universal',
        file: 'dist/ClipboardSync-mac-universal.dmg',
        bytes: overrides.bytes ?? bytes,
        sha256: overrides.sha256 || sha256,
        containsPackagedToken: true,
        config: { hasToken: true }
      }
    ]
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(sha256Path, overrides.sha256Text || `${sha256}  dist/ClipboardSync-mac-universal.dmg\n`);
  return { manifestPath, sha256Path };
}

test('verifyReleaseManifest accepts matching manifest, checksums, files, and git commit', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'clipboard-release-verify-'));

  try {
    await writeReleaseFixture(root, { gitCommit: 'abc1234' });
    await verifyReleaseManifest({ projectRoot: root, gitCommit: 'abc1234' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyReleaseManifest rejects stale package hashes and checksum files', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'clipboard-release-verify-'));

  try {
    await writeReleaseFixture(root, { sha256: '0'.repeat(64), sha256Text: `${'1'.repeat(64)}  dist/ClipboardSync-mac-universal.dmg\n` });
    await assert.rejects(() => verifyReleaseManifest({ projectRoot: root, gitCommit: 'abc1234' }), /sha256 mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyReleaseManifest rejects a manifest from a different commit', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'clipboard-release-verify-'));

  try {
    await writeReleaseFixture(root, { gitCommit: 'old1234' });
    await assert.rejects(() => verifyReleaseManifest({ projectRoot: root, gitCommit: 'new5678' }), /gitCommit mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
