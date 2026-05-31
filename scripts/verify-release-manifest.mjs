import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formatSha256Sums, sha256File } from './write-release-manifest.mjs';

const defaultProjectRoot = fileURLToPath(new URL('..', import.meta.url));

function currentGitCommit(projectRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

export async function verifyReleaseManifest({
  projectRoot = defaultProjectRoot,
  manifestPath = join(projectRoot, 'dist/RELEASE_MANIFEST.json'),
  sha256Path = join(projectRoot, 'dist/SHA256SUMS.txt'),
  gitCommit = currentGitCommit(projectRoot)
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (gitCommit && manifest.gitCommit !== gitCommit) {
    throw new Error(`release manifest gitCommit mismatch: expected ${gitCommit}, got ${manifest.gitCommit}`);
  }
  const expectedPrivatePackage = (manifest.packages || []).some((pkg) => pkg.containsPackagedToken);
  if (manifest.privatePackage !== expectedPrivatePackage) {
    throw new Error(
      `release manifest privatePackage mismatch: expected ${expectedPrivatePackage}, got ${manifest.privatePackage}`
    );
  }

  for (const pkg of manifest.packages || []) {
    const packagePath = join(projectRoot, pkg.file);
    const packageStats = await stat(packagePath);
    if (pkg.bytes !== packageStats.size) {
      throw new Error(`${pkg.file} byte size mismatch: expected ${packageStats.size}, got ${pkg.bytes}`);
    }
    const sha256 = await sha256File(packagePath);
    if (pkg.sha256 !== sha256) {
      throw new Error(`${pkg.file} sha256 mismatch: expected ${sha256}, got ${pkg.sha256}`);
    }
  }

  const expectedSha256Text = formatSha256Sums(manifest);
  const actualSha256Text = await readFile(sha256Path, 'utf8');
  if (actualSha256Text !== expectedSha256Text) {
    throw new Error('SHA256SUMS.txt does not match release manifest');
  }

  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyReleaseManifest();
  console.log('release manifest verified');
}
