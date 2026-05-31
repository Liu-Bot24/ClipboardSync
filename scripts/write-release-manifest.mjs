import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultProjectRoot = fileURLToPath(new URL('..', import.meta.url));

function defaultTargets(projectRoot) {
  return [
    {
      name: 'mac-universal',
      platform: 'darwin-universal',
      packagePath: join(projectRoot, 'dist/ClipboardSync-mac-universal.dmg'),
      configPath: join(projectRoot, 'dist/ClipboardSync-darwin-universal/ClipboardSync.app/Contents/Resources/clipboard-sync.config.json')
    },
    {
      name: 'windows-x64',
      platform: 'win32-x64',
      packagePath: join(projectRoot, 'dist/ClipboardSync-windows-x64.zip'),
      configEntry: 'ClipboardSync-win32-x64/clipboard-sync.config.json',
      configPath: join(projectRoot, 'dist/ClipboardSync-win32-x64/clipboard-sync.config.json')
    }
  ];
}

function toManifestPath(projectRoot, filePath) {
  return relative(projectRoot, filePath).split(sep).join('/');
}

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

export async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

async function readPackagedConfig(source) {
  if (typeof source === 'string') {
    return JSON.parse(await readFile(source, 'utf8'));
  }
  if (source.configEntry) {
    return JSON.parse(
      execFileSync('unzip', ['-p', source.packagePath, source.configEntry], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
      })
    );
  }
  return JSON.parse(await readFile(source.configPath, 'utf8'));
}

export async function readPackagedConfigSummary(source) {
  const config = await readPackagedConfig(source);

  return {
    hubUrl: config.hubUrl || '',
    hasToken: Boolean(config.token),
    autoLaunch: Boolean(config.autoLaunch),
    pauseSend: Boolean(config.pauseSend),
    pauseReceive: Boolean(config.pauseReceive),
    maxSendBytes: config.maxSendBytes ?? null,
    ruleCount: Object.keys(config.deviceRules || {}).length
  };
}

export async function buildReleaseManifest({
  projectRoot = defaultProjectRoot,
  generatedAt = new Date().toISOString(),
  gitCommit = currentGitCommit(projectRoot),
  targets = defaultTargets(projectRoot)
} = {}) {
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const packages = [];

  for (const target of targets) {
    const packageStats = await stat(target.packagePath);
    const config = await readPackagedConfigSummary(target);
    packages.push({
      name: target.name,
      platform: target.platform,
      file: toManifestPath(projectRoot, target.packagePath),
      bytes: packageStats.size,
      sha256: await sha256File(target.packagePath),
      containsPackagedToken: config.hasToken,
      config
    });
  }
  const privatePackage = packages.some((pkg) => pkg.containsPackagedToken);

  return {
    project: packageJson.name,
    version: packageJson.version,
    privatePackage,
    generatedAt,
    gitCommit,
    packages
  };
}

export function formatSha256Sums(manifest) {
  return manifest.packages.map((pkg) => `${pkg.sha256}  ${pkg.file}`).join('\n') + '\n';
}

export async function writeReleaseFiles({
  projectRoot = defaultProjectRoot,
  manifestPath = join(projectRoot, 'dist/RELEASE_MANIFEST.json'),
  sha256Path = join(projectRoot, 'dist/SHA256SUMS.txt'),
  generatedAt,
  gitCommit,
  targets = defaultTargets(projectRoot)
} = {}) {
  const manifest = await buildReleaseManifest({ projectRoot, generatedAt, gitCommit, targets });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(sha256Path, formatSha256Sums(manifest));
  for (const target of targets) {
    await chmod(target.packagePath, 0o600);
  }
  await chmod(manifestPath, 0o600);
  await chmod(sha256Path, 0o600);
  return { manifest, manifestPath, sha256Path };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { manifestPath, sha256Path } = await writeReleaseFiles();
  console.log(`release manifest written: ${toManifestPath(defaultProjectRoot, manifestPath)}`);
  console.log(`sha256 sums written: ${toManifestPath(defaultProjectRoot, sha256Path)}`);
}
