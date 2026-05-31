import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractFile } from '@electron/asar';

import {
  fail,
  validateAsarEntries,
  validateForbiddenZipEntries,
  validateMacSafeStorageSwitches,
  validatePackageTargetNames,
  validateRequiredZipEntries,
  withPackageReader
} from './verify-package-artifacts.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

const publicTargets = [
  {
    name: 'mac',
    packageType: 'dmg',
    path: join(projectRoot, 'dist/ClipboardSync-mac-universal.dmg'),
    asarEntry: 'ClipboardSync.app/Contents/Resources/app.asar',
    configEntry: 'ClipboardSync.app/Contents/Resources/clipboard-sync.config.json',
    requiredEntries: [
      'Applications',
      'ClipboardSync.app/Contents/MacOS/ClipboardSync',
      'ClipboardSync.app/Contents/Resources/app.asar',
      'ClipboardSync.app/Contents/Resources/clipboard-sync.config.json',
      'ClipboardSync.app/Contents/Resources/local-hub-proxy',
      'ClipboardSync.app/Contents/Resources/mac-paste-helper'
    ],
    forbiddenEntries: [
      'ClipboardSync.app/Contents/Resources/clipboard-sync.proxy.json'
    ]
  },
  {
    name: 'windows',
    packageType: 'zip',
    path: join(projectRoot, 'dist/ClipboardSync-windows-x64.zip'),
    asarEntry: 'ClipboardSync-win32-x64/resources/app.asar',
    configEntry: 'ClipboardSync-win32-x64/clipboard-sync.config.json',
    requiredEntries: [
      'ClipboardSync-win32-x64/ClipboardSync.exe',
      'ClipboardSync-win32-x64/resources/app.asar',
      'ClipboardSync-win32-x64/clipboard-sync.config.json',
      'ClipboardSync-win32-x64/resources.pak',
      'ClipboardSync-win32-x64/icudtl.dat',
      'ClipboardSync-win32-x64/ffmpeg.dll',
      'ClipboardSync-win32-x64/libEGL.dll',
      'ClipboardSync-win32-x64/libGLESv2.dll',
      'ClipboardSync-win32-x64/snapshot_blob.bin',
      'ClipboardSync-win32-x64/v8_context_snapshot.bin',
      'ClipboardSync-win32-x64/chrome_100_percent.pak',
      'ClipboardSync-win32-x64/chrome_200_percent.pak',
      'ClipboardSync-win32-x64/d3dcompiler_47.dll',
      'ClipboardSync-win32-x64/dxcompiler.dll',
      'ClipboardSync-win32-x64/dxil.dll',
      'ClipboardSync-win32-x64/vulkan-1.dll',
      'ClipboardSync-win32-x64/vk_swiftshader.dll',
      'ClipboardSync-win32-x64/vk_swiftshader_icd.json',
      'ClipboardSync-win32-x64/locales/en-US.pak',
      'ClipboardSync-win32-x64/locales/zh-CN.pak'
    ],
    forbiddenEntries: []
  }
];

function asarEntries(path) {
  return execFileSync(join(projectRoot, 'node_modules/.bin/asar'), ['list', path], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function validatePublicConfig(target, readEntry) {
  const config = JSON.parse(readEntry(target.path, target.configEntry).toString('utf8'));
  if (config.hubUrl || config.token) {
    fail(`${target.name} public package must not include a Hub URL or token`);
  }
  if (config.autoLaunch !== true) {
    fail(`${target.name} public package should keep first-run autoLaunch default enabled`);
  }
  if (config.publicPackage !== true) {
    fail(`${target.name} public package config must be marked publicPackage=true`);
  }
  return config;
}

function validateNoPrivateLanDefaults(target, entries, readEntry) {
  const privateLanPattern = /192\.168\.6\.(?:171|237)/;
  for (const entry of entries) {
    if (!/\.(asar|c|cmd|html|js|json|mjs|ps1|txt|yml|yaml)$/i.test(entry)) {
      continue;
    }
    if (privateLanPattern.test(readEntry(target.path, entry).toString('utf8'))) {
      fail(`${target.name} public package contains a private LAN default in ${entry}`);
    }
  }
}

function validateForbiddenPublicEntries(target, entries) {
  const forbidden = target.forbiddenEntries.filter((entry) => entries.includes(entry));
  if (forbidden.length > 0) {
    fail(`${target.name} public package contains private-only entries:\n${forbidden.join('\n')}`);
  }
}

export function verifyPublicPackageArtifacts({ targets = publicTargets } = {}) {
  validatePackageTargetNames(targets);
  for (const target of targets) {
    withPackageReader(target, ({ entries, label, readEntry }) => {
      validateForbiddenZipEntries(target, entries);
      validateRequiredZipEntries(target, entries);
      validateForbiddenPublicEntries(target, entries);
      validatePublicConfig(target, readEntry);
      validateNoPrivateLanDefaults(target, entries, readEntry);

      const tempDir = mkdtempSync(join(tmpdir(), `clipboard-public-${target.name}-asar-`));
      try {
        const asarPath = join(tempDir, 'app.asar');
        writeFileSync(asarPath, readEntry(target.path, target.asarEntry));
        validateAsarEntries(`${target.name} ${label}:${target.asarEntry}`, asarEntries(asarPath));
        if (target.name === 'mac') {
          validateMacSafeStorageSwitches(`${target.name} ${label}:${target.asarEntry}`, asarPath, extractFile);
        }
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPublicPackageArtifacts();
  console.log('public package artifacts verified');
}
