import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const buildDirs = ['ClipboardSync-darwin-universal', 'ClipboardSync-win32-x64'];

export async function cleanPackageBuildDirs(root = projectRoot) {
  await Promise.all(buildDirs.map((dir) => rm(join(root, 'dist', dir), { recursive: true, force: true })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cleanPackageBuildDirs();
}
