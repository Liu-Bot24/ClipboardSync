import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const execFileAsync = promisify(execFile);
const packageDmg = join(projectRoot, 'dist/ClipboardSync-mac-universal.dmg');
const tmpDir = join(projectRoot, 'tmp');
const stdoutPath = join(tmpDir, 'smoke-mac-package.out');
const stderrPath = join(tmpDir, 'smoke-mac-package.err');
const readyPath = join(tmpDir, 'smoke-mac-ready.json');
const allowedSmokeHubHosts = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  ...(process.env.CLIPBOARD_SYNC_ALLOWED_SMOKE_HUB_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(child, ms) {
  const timeout = wait(ms).then(() => null);
  const exit = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  return Promise.race([exit, timeout]);
}

function assertAllowedSmokeHub(hubUrl) {
  const url = new URL(hubUrl);
  if (!allowedSmokeHubHosts.has(url.hostname)) {
    throw new Error(`Refusing to smoke test against unexpected Hub host: ${url.hostname}`);
  }
  return url.origin;
}

async function readPackagedHubUrl(appRoot) {
  const configPath = join(appRoot, 'ClipboardSync.app/Contents/Resources/clipboard-sync.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config.hubUrl) {
    throw new Error(`packaged config is missing hubUrl: ${configPath}`);
  }
  return assertAllowedSmokeHub(config.hubUrl);
}

async function mountDmg(dmgPath, mountPoint) {
  await execFileAsync('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint]);
}

async function detachDmg(mountPoint) {
  try {
    await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet']);
  } catch {
    await execFileAsync('hdiutil', ['detach', mountPoint, '-force', '-quiet']);
  }
}

async function launchPackagedProxy(appRoot) {
  const proxyExecutable = join(appRoot, 'ClipboardSync.app/Contents/Resources/local-hub-proxy');
  const proxyConfig = join(appRoot, 'ClipboardSync.app/Contents/Resources/clipboard-sync.proxy.json');
  await stat(proxyExecutable);
  await stat(proxyConfig);

  return spawn(proxyExecutable, [], {
    cwd: appRoot,
    env: {
      ...process.env,
      CLIPBOARD_SYNC_PROXY_CONFIG: proxyConfig
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function assertHealth(label, hubUrl) {
  const response = await fetch(`${hubUrl}/health`);
  if (!response.ok) {
    throw new Error(`${label} health failed: ${response.status}`);
  }
  const body = await response.json();
  if (body.status !== 'ok') {
    throw new Error(`${label} health is not ok`);
  }
  return body;
}

async function hasHealth(hubUrl) {
  try {
    await assertHealth('existing', hubUrl);
    return true;
  } catch {
    return false;
  }
}

function assertChildRunning(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`${label}: packaged Mac app exited early with code=${child.exitCode} signal=${child.signalCode}`);
  }
}

function unexpectedStderr(stderr) {
  return stderr
    .split('\n')
    .filter(Boolean)
    .filter(
      (line) =>
        !/ERROR:base\/process\/process_mac\.cc:\d+\] task_policy_set TASK_(CATEGORY|SUPPRESSION)_POLICY: \(os\/kern\) invalid argument \(4\)/.test(
          line
        )
    );
}

async function waitForReadyMarker(child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, 'ready marker wait');
    try {
      const marker = JSON.parse(await readFile(readyPath, 'utf8'));
      if (marker.status === 'ready') {
        if (!marker.safeStorageKeychain?.enabled) {
          throw new Error('packaged Mac app did not enable safe storage keychain suppression');
        }
        return marker;
      }
    } catch {
      // The marker is written asynchronously by the packaged app.
    }
    await wait(250);
  }
  throw new Error(`packaged Mac app did not write ready marker: ${readyPath}`);
}

async function waitForHubConnection(child, hubUrl, before, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, 'hub connection wait');
    const during = await assertHealth('during', hubUrl);
    if (during.connections > before.connections) {
      return during;
    }
    await wait(500);
  }
  throw new Error(`connections did not increase above ${before.connections}`);
}

await stat(packageDmg);
await mkdir(tmpDir, { recursive: true });
await rm(stdoutPath, { force: true });
await rm(stderrPath, { force: true });
await rm(readyPath, { force: true });

const scratch = await mkdtemp(join(tmpDir, 'smoke-mac-package-'));
const mountPoint = join(scratch, 'dmg');
let child;
let proxyChild;
let mounted = false;
try {
  await mkdir(mountPoint);
  await mountDmg(packageDmg, mountPoint);
  mounted = true;

  const appExecutable = join(mountPoint, 'ClipboardSync.app/Contents/MacOS/ClipboardSync');
  await stat(appExecutable);
  await stat(join(mountPoint, 'Applications'));
  const hubUrl = await readPackagedHubUrl(mountPoint);

  if (assertAllowedSmokeHub(hubUrl) === 'http://127.0.0.1:18787' && !(await hasHealth(hubUrl))) {
    proxyChild = await launchPackagedProxy(mountPoint);
    await wait(1000);
    assertChildRunning(proxyChild, 'packaged local proxy');
  }

  const before = await assertHealth('before', hubUrl);
  child = spawn(appExecutable, [], {
    cwd: scratch,
    env: {
      ...process.env,
      CLIPBOARD_SYNC_DISABLE_AUTO_LAUNCH: '1',
      CLIPBOARD_SYNC_LOG_FILE: join(tmpDir, 'smoke-mac-package.log'),
      CLIPBOARD_SYNC_USER_DATA_DIR: join(scratch, 'user-data'),
      CLIPBOARD_SYNC_READY_FILE: readyPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const ready = await waitForReadyMarker(child);
  const during = await waitForHubConnection(child, hubUrl, before);
  child.kill('SIGTERM');
  let exit = await waitForExit(child, 2_000);
  if (!exit) {
    child.kill('SIGKILL');
    exit = await waitForExit(child, 2_000);
  }
  if (!exit) {
    throw new Error('packaged Mac app did not exit after SIGKILL');
  }
  const after = await assertHealth('after', hubUrl);

  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  const unexpected = unexpectedStderr(stderr.toString('utf8'));
  if (unexpected.length > 0) {
    throw new Error(`packaged Mac app wrote unexpected stderr:\n${unexpected.join('\n')}`);
  }

  console.log(`before connections=${before.connections}`);
  console.log(`during connections=${during.connections}`);
  console.log(`after connections=${after.connections}`);
  console.log(`ready marker status=${ready.status}`);
  console.log(`safe storage keychain suppression=${ready.safeStorageKeychain.enabled}`);
  console.log(`stdout bytes=${stdout.length}`);
  console.log(`ignored stderr lines=${stderr.length > 0 ? stderr.toString('utf8').split('\n').filter(Boolean).length - unexpected.length : 0}`);
} finally {
  child?.kill?.('SIGKILL');
  proxyChild?.kill?.('SIGKILL');
  if (mounted) {
    await detachDmg(mountPoint);
  }
  await rm(scratch, { force: true, recursive: true });
}
