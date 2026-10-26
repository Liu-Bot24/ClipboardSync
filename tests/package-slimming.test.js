import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { clangArchArgs, macArch, macAppPath, macDmgName } from '../scripts/mac-target.mjs';
import { stripMacLocales, stripWindowsLocales } from '../scripts/strip-electron-locales.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(os.tmpdir(), 'clipboard-slimming-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test('mac target defaults to arm64 and accepts only known architectures', () => {
  assert.equal(macArch({}), 'arm64');
  assert.equal(macArch({ CLIPBOARD_SYNC_MAC_ARCH: 'x64' }), 'x64');
  assert.throws(() => macArch({ CLIPBOARD_SYNC_MAC_ARCH: 'ppc' }), /must be one of/);
  assert.equal(macDmgName('arm64'), 'ClipboardSync-mac-arm64.dmg');
  assert.match(macAppPath('/root', 'universal').replaceAll('\\', '/'), /dist\/ClipboardSync-darwin-universal\/ClipboardSync\.app$/);
  assert.deepEqual(clangArchArgs('arm64'), ['-arch', 'arm64']);
  assert.deepEqual(clangArchArgs('x64'), ['-arch', 'x86_64']);
  assert.deepEqual(clangArchArgs('universal'), ['-arch', 'arm64', '-arch', 'x86_64']);
});

test('stripWindowsLocales keeps only en-US and zh-CN locale packs', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'locales'));
    for (const name of ['en-US.pak', 'zh-CN.pak', 'ja.pak', 'de.pak', 'zh-TW.pak']) {
      await writeFile(join(dir, 'locales', name), 'x'.repeat(10));
    }
    await writeFile(join(dir, 'resources.pak'), 'keep');

    const result = await stripWindowsLocales(dir);

    assert.deepEqual((await readdir(join(dir, 'locales'))).sort(), ['en-US.pak', 'zh-CN.pak']);
    assert.deepEqual(result.removed.sort(), ['de.pak', 'ja.pak', 'zh-TW.pak']);
    assert.equal(result.removedBytes, 30);
    assert.deepEqual((await readdir(dir)).sort(), ['locales', 'resources.pak']);
  });
});

test('stripMacLocales keeps en and zh_CN in the Electron framework resources', async () => {
  await withTempDir(async (dir) => {
    const app = join(dir, 'ClipboardSync.app');
    const resources = join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources');
    for (const name of ['en.lproj', 'zh_CN.lproj', 'fr.lproj', 'ko.lproj']) {
      await mkdir(join(resources, name), { recursive: true });
      await writeFile(join(resources, name, 'locale.pak'), 'pak');
    }
    await writeFile(join(resources, 'resources.pak'), 'keep');

    await stripMacLocales(app);

    assert.deepEqual((await readdir(resources)).sort(), ['en.lproj', 'resources.pak', 'zh_CN.lproj']);
  });
});

test('locale stripping refuses a package that lacks a required locale', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'locales'));
    await writeFile(join(dir, 'locales', 'en-US.pak'), 'x');
    await writeFile(join(dir, 'locales', 'ja.pak'), 'x');

    await assert.rejects(stripWindowsLocales(dir), /zh-CN\.pak is missing/);
    assert.deepEqual((await readdir(join(dir, 'locales'))).sort(), ['en-US.pak', 'ja.pak']);
  });
});
