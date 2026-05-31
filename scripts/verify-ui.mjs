import { spawn } from 'node:child_process';
import electronPath from 'electron';

function run(command, args, env = {}, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: 'inherit'
    });
    const timeout = setTimeout(() => {
      if (finished) {
        return;
      }
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      finished = true;
      clearTimeout(timeout);
      if (signal) {
        reject(new Error(`${command} ${args.join(' ')} exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

for (const theme of ['light', 'dark']) {
  await run(electronPath, ['.'], {
    CLIPBOARD_SYNC_QA_CAPTURE: '1',
    CLIPBOARD_SYNC_QA_FIXTURE: '1',
    CLIPBOARD_SYNC_QA_THEME: theme,
    CLIPBOARD_SYNC_DISABLE_AUTO_LAUNCH: '1'
  });
  await run(process.execPath, ['scripts/assert-qa-screenshots.mjs'], {
    CLIPBOARD_SYNC_QA_THEME: theme
  });
}
