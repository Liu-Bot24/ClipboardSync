import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { macAppPath } from './mac-target.mjs';

// The client UI ships its own zh-CN/en strings; Chromium only needs its
// locale for built-in text such as context menus. Other locales fall back to en.
export const KEPT_WINDOWS_LOCALES = new Set(['en-US.pak', 'zh-CN.pak']);
export const KEPT_MAC_LOCALES = new Set(['en.lproj', 'zh_CN.lproj']);

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function stripEntries(dir, keep, isLocale) {
  const entries = await readdir(dir);
  const present = entries.filter(isLocale);
  for (const name of keep) {
    if (!present.includes(name)) throw new Error(`required locale ${name} is missing in ${dir}`);
  }
  let removedBytes = 0;
  const removed = [];
  for (const name of present) {
    if (keep.has(name)) continue;
    const path = join(dir, name);
    removedBytes += await sizeOf(path);
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
  return { dir, removed, removedBytes };
}

async function sizeOf(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path)) total += await sizeOf(join(path, name));
  return total;
}

export function stripWindowsLocales(appDir) {
  return stripEntries(join(appDir, 'locales'), KEPT_WINDOWS_LOCALES, (name) => name.endsWith('.pak'));
}

export function stripMacLocales(appPath) {
  const framework = join(appPath, 'Contents/Frameworks/Electron Framework.framework');
  const versioned = join(framework, 'Versions/A/Resources');
  return stripEntries(existsSync(versioned) ? versioned : join(framework, 'Resources'), KEPT_MAC_LOCALES, (name) => name.endsWith('.lproj'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const platform = process.argv[2];
  const result = platform === 'win32'
    ? await stripWindowsLocales(join(projectRoot, 'dist/ClipboardSync-win32-x64'))
    : platform === 'darwin'
      ? await stripMacLocales(macAppPath(projectRoot))
      : null;
  if (!result) {
    console.error('usage: node scripts/strip-electron-locales.mjs win32|darwin');
    process.exit(64);
  }
  console.log(`stripped ${result.removed.length} locales (${(result.removedBytes / 1048576).toFixed(1)} MB) from ${result.dir}`);
}
