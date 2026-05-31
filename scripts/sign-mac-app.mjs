import { execFileSync } from 'node:child_process';

const appPath = 'dist/ClipboardSync-darwin-universal/ClipboardSync.app';
const entitlementsPath = 'build/ClipboardSync.entitlements';

execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlementsPath, appPath], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
