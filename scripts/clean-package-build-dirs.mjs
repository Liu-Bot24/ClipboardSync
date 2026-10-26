import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function isBuildDir(name) {
  // Any Mac architecture (arm64, x64, universal) plus the Windows app folder.
  return name.startsWith('ClipboardSync-darwin-') || name === 'ClipboardSync-win32-x64';
}

export async function cleanPackageBuildDirs(root = projectRoot) {
  let entries;
  try {
    entries = await readdir(join(root, 'dist'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries.filter(isBuildDir).map((dir) => rm(join(root, 'dist', dir), { recursive: true, force: true })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cleanPackageBuildDirs();
}
