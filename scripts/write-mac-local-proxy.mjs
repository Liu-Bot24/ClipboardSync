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

export async function writeMacLocalProxy(resourcesDir = defaultResourcesDir) {
  const target = join(resourcesDir, 'local-hub-proxy');
  await mkdir(dirname(target), { recursive: true });
  await execFileAsync('xcrun', [
    'clang',
    '-O2',
    '-Wall',
    '-Wextra',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    join(projectRoot, 'scripts/local-hub-proxy.c'),
    '-o',
    target
  ]);
  await chmod(target, 0o755);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = await writeMacLocalProxy();
  console.log(`mac local proxy written: ${target}`);
}
