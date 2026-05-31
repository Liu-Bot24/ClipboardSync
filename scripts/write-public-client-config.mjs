import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createClientBootstrapConfig } from './client-bootstrap-config.mjs';

const BOOTSTRAP_NAME = 'clipboard-sync.config.json';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function writeBootstrap(path, config) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writePublicClientConfig() {
  const publicBootstrap = {
    ...createClientBootstrapConfig({}, {}),
    publicPackage: true
  };
  const targets = [
    join(projectRoot, 'dist/ClipboardSync-darwin-universal/ClipboardSync.app/Contents/Resources', BOOTSTRAP_NAME),
    join(projectRoot, 'dist/ClipboardSync-win32-x64', BOOTSTRAP_NAME)
  ];

  for (const target of targets) {
    await writeBootstrap(target, publicBootstrap);
  }
  return targets;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targets = await writePublicClientConfig();
  console.log(`public client config written: ${targets.length}`);
}
