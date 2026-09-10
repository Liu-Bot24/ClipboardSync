import { pathToFileURL } from 'node:url';

export function assertPackagingNode(version = process.versions.node) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const major = Number(parts?.[1]);
  const minor = Number(parts?.[2]);
  if (!parts || !((major === 22 && minor >= 12) || major === 24)) {
    throw new Error('Use Node.js 22.12+ (22.x) or 24.x to package the client. Electron Packager 20 can exit without producing an app on Node.js 26.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertPackagingNode();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
