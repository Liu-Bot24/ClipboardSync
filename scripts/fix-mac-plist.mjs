import { execFileSync } from 'node:child_process';

const plist = 'dist/ClipboardSync-darwin-universal/ClipboardSync.app/Contents/Info.plist';
const buddy = '/usr/libexec/PlistBuddy';

function run(args, options = {}) {
  try {
    execFileSync(buddy, args, { stdio: options.stdio || 'ignore' });
  } catch (error) {
    if (!options.ignoreError) {
      throw error;
    }
  }
}

for (const key of [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSBluetoothAlwaysUsageDescription'
]) {
  run(['-c', `Delete :${key}`, plist], { ignoreError: true });
}

run(['-c', 'Set :CFBundleDisplayName Clipboard Sync', plist]);
run(['-c', 'Set :CFBundleName ClipboardSync', plist]);
run(['-c', 'Delete :NSLocalNetworkUsageDescription', plist], { ignoreError: true });
run([
  '-c',
  'Add :NSLocalNetworkUsageDescription string Clipboard Sync needs local network access to connect to the clipboard hub and nearby devices.',
  plist
]);
run(['-c', 'Add :LSUIElement bool true', plist], { ignoreError: true });
run(['-c', 'Set :LSUIElement true', plist], { ignoreError: true });
