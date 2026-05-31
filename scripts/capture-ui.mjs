import { spawn } from 'node:child_process';
import electronPath from 'electron';

const fixture = process.argv.includes('--fixture');

const child = spawn(electronPath, ['.'], {
  env: {
    ...process.env,
    CLIPBOARD_SYNC_QA_CAPTURE: '1',
    ...(fixture ? { CLIPBOARD_SYNC_QA_FIXTURE: '1' } : {})
  },
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
