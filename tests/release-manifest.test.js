import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildReleaseManifest, formatSha256Sums, writeReleaseFiles } from '../scripts/write-release-manifest.mjs';

test('buildReleaseManifest records package metadata without leaking the packaged token', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'clipboard-release-manifest-'));

  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'clipboard-hub', version: '0.1.0' }));

    const packagePath = join(root, 'dist/ClipboardSync-mac-universal.dmg');
    const configPath = join(root, 'dist/ClipboardSync-darwin-universal/ClipboardSync.app/Contents/Resources/clipboard-sync.config.json');
    await mkdir(join(root, 'dist/ClipboardSync-darwin-universal/ClipboardSync.app/Contents/Resources'), { recursive: true });
    await writeFile(packagePath, 'mac-package-bytes');
    await writeFile(configPath, JSON.stringify({
      hubUrl: 'http://192.0.2.10:8787',
      token: 'secret-token-that-must-not-leak',
      autoLaunch: true,
      pauseSend: false,
      pauseReceive: false,
      maxSendBytes: 33554432,
      deviceRules: {
        'main-pc': { send: true, receive: true }
      }
    }));

    const manifest = await buildReleaseManifest({
      projectRoot: root,
      generatedAt: '2026-06-01T00:00:00.000Z',
      gitCommit: 'abc1234',
      targets: [{
        name: 'mac-universal',
        platform: 'darwin-universal',
        packagePath,
        configPath
      }]
    });

    assert.equal(manifest.project, 'clipboard-hub');
    assert.equal(manifest.version, '0.1.0');
    assert.equal(manifest.generatedAt, '2026-06-01T00:00:00.000Z');
    assert.equal(manifest.gitCommit, 'abc1234');
    assert.equal(manifest.privatePackage, true);
    assert.equal(manifest.packages[0].containsPackagedToken, true);
    assert.deepEqual(manifest.packages[0].config, {
      hubUrl: 'http://192.0.2.10:8787',
      hasToken: true,
      autoLaunch: true,
      pauseSend: false,
      pauseReceive: false,
      maxSendBytes: 33554432,
      ruleCount: 1
    });
    assert.equal(manifest.packages[0].platform, 'darwin-universal');
    assert.equal(manifest.packages[0].file, 'dist/ClipboardSync-mac-universal.dmg');
    assert.equal(manifest.packages[0].bytes, 17);
    assert.match(manifest.packages[0].sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(manifest), /secret-token-that-must-not-leak/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeReleaseFiles tightens private package and checksum permissions', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'clipboard-release-files-'));

  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'clipboard-hub', version: '0.1.0' }));

    const packagePath = join(root, 'dist/ClipboardSync-mac-universal.dmg');
    const configPath = join(root, 'dist/ClipboardSync-darwin-universal/ClipboardSync.app/Contents/Resources/clipboard-sync.config.json');
    const manifestPath = join(root, 'dist/RELEASE_MANIFEST.json');
    const sha256Path = join(root, 'dist/SHA256SUMS.txt');
    await mkdir(join(root, 'dist/ClipboardSync-darwin-universal/ClipboardSync.app/Contents/Resources'), { recursive: true });
    await writeFile(packagePath, 'mac-package-bytes');
    await writeFile(configPath, JSON.stringify({ hubUrl: 'http://192.0.2.10:8787', token: 'long-private-token-value', deviceRules: {} }));

    await writeReleaseFiles({
      projectRoot: root,
      generatedAt: '2026-06-01T00:00:00.000Z',
      gitCommit: 'abc1234',
      manifestPath,
      sha256Path,
      targets: [{
        name: 'mac-universal',
        platform: 'darwin-universal',
        packagePath,
        configPath
      }]
    });

    assert.equal((await stat(packagePath)).mode & 0o777, 0o600);
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
    assert.equal((await stat(sha256Path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildReleaseManifest marks token-free public packages as non-private', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'clipboard-public-release-manifest-'));

  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'clipboard-hub', version: '0.1.0' }));

    const packagePath = join(root, 'dist/ClipboardSync-windows-x64.zip');
    const configPath = join(root, 'dist/ClipboardSync-win32-x64/clipboard-sync.config.json');
    await mkdir(join(root, 'dist/ClipboardSync-win32-x64'), { recursive: true });
    await writeFile(packagePath, 'windows-package-bytes');
    await writeFile(configPath, JSON.stringify({ hubUrl: '', token: '', autoLaunch: true, deviceRules: {} }));

    const manifest = await buildReleaseManifest({
      projectRoot: root,
      generatedAt: '2026-06-01T00:00:00.000Z',
      gitCommit: 'abc1234',
      targets: [{
        name: 'windows-x64',
        platform: 'win32-x64',
        packagePath,
        configPath
      }]
    });

    assert.equal(manifest.privatePackage, false);
    assert.equal(manifest.packages[0].containsPackagedToken, false);
    assert.equal(manifest.packages[0].config.hubUrl, '');
    assert.equal(manifest.packages[0].config.hasToken, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('formatSha256Sums writes standard checksum lines for every package', () => {
  const checksums = formatSha256Sums({
    packages: [
      { sha256: 'a'.repeat(64), file: 'dist/ClipboardSync-mac-universal.dmg' },
      { sha256: 'b'.repeat(64), file: 'dist/ClipboardSync-windows-x64.zip' }
    ]
  });

  assert.equal(checksums, `${'a'.repeat(64)}  dist/ClipboardSync-mac-universal.dmg\n${'b'.repeat(64)}  dist/ClipboardSync-windows-x64.zip\n`);
});
