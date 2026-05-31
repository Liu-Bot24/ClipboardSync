import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultResourcesDir = join(
  projectRoot,
  'dist/ClipboardSync-darwin-universal/ClipboardSync.app/Contents/Resources'
);

export async function writeMacPasteHelper(resourcesDir = defaultResourcesDir) {
  const target = join(resourcesDir, 'mac-paste-helper');
  await mkdir(dirname(target), { recursive: true });
  await execFileAsync('xcrun', [
    'clang',
    '-O2',
    '-Wall',
    '-Wextra',
    '-fobjc-arc',
    '-framework',
    'Cocoa',
    '-framework',
    'ApplicationServices',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    join(projectRoot, 'scripts/mac-paste-helper.m'),
    '-o',
    target
  ]);
  await chmod(target, 0o755);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = await writeMacPasteHelper();
  console.log(`mac paste helper written: ${target}`);
}
