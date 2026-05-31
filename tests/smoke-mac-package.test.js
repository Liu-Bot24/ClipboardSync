import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('smoke-mac-package launches the app from the distribution DMG', async () => {
  const script = await readFile('scripts/smoke-mac-package.mjs', 'utf8');

  assert.match(script, /ClipboardSync-mac-universal\.dmg/);
  assert.match(script, /mkdtemp/);
  assert.match(script, /hdiutil/);
  assert.match(script, /Applications/);
  assert.match(script, /CLIPBOARD_SYNC_READY_FILE/);
  assert.match(script, /waitForReadyMarker/);
  assert.match(script, /safeStorageKeychain/);
  assert.match(script, /safe storage keychain suppression/);
  assert.match(script, /unexpectedStderr/);
  assert.match(script, /TASK_\(CATEGORY\|SUPPRESSION\)_POLICY/);
  assert.match(script, /waitForHubConnection/);
  assert.match(script, /connections did not increase/);
  assert.match(script, /clipboard-sync\.config\.json/);
  assert.match(script, /assertAllowedSmokeHub/);
  assert.match(script, /allowedSmokeHubHosts/);
  assert.match(script, /CLIPBOARD_SYNC_ALLOWED_SMOKE_HUB_HOSTS/);
  assert.doesNotMatch(script, /192\.168\.6\./);
  assert.match(script, /CLIPBOARD_SYNC_USER_DATA_DIR/);
  assert.doesNotMatch(script, /ClipboardSync-mac-arm64/);
  assert.doesNotMatch(script, /dist\/ClipboardSync-darwin-(arm64|x64)\/ClipboardSync\.app\/Contents\/MacOS\/ClipboardSync/);
});
