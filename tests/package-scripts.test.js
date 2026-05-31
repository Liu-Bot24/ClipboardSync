import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('package:configured creates a Mac DMG and a portable Windows zip', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const command = packageJson.scripts['package:configured'];
  const iconsIndex = command.indexOf('npm run icons');
  const macIndex = command.indexOf('npm run package:mac');
  const winIndex = command.indexOf('npm run package:win');
  const macProxyIndex = command.indexOf('node scripts/write-mac-local-proxy.mjs');
  const macPasteIndex = command.indexOf('node scripts/write-mac-paste-helper.mjs');
  const macDmgIndex = command.indexOf('node scripts/create-mac-dmg.mjs');
  const zipIndex = command.indexOf('zip -qr -X ClipboardSync-windows-x64.zip');
  const cleanupIndex = command.indexOf('node ../scripts/clean-package-build-dirs.mjs');

  assert.notEqual(iconsIndex, -1);
  assert.notEqual(macIndex, -1);
  assert.notEqual(winIndex, -1);
  assert.notEqual(macProxyIndex, -1);
  assert.notEqual(macPasteIndex, -1);
  assert.notEqual(macDmgIndex, -1);
  assert.notEqual(zipIndex, -1);
  assert.notEqual(cleanupIndex, -1);
  assert.doesNotMatch(command, /write-mac-install-helper\.mjs/);
  assert.doesNotMatch(command, /write-windows-install-helper\.mjs/);
  assert.doesNotMatch(command, /ClipboardSync-mac-universal\.zip/);
  assert.equal(iconsIndex < macIndex, true);
  assert.equal(iconsIndex < winIndex, true);
  assert.equal(macProxyIndex < macPasteIndex, true);
  assert.equal(macPasteIndex < macDmgIndex, true);
  assert.equal(macProxyIndex < macDmgIndex, true);
  assert.equal(macIndex < macDmgIndex, true);
  assert.equal(macDmgIndex < zipIndex, true);
  assert.equal(zipIndex < cleanupIndex, true);
});

test('package:release writes public config and verifies token-free release artifacts', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const command = packageJson.scripts['package:release'];

  assert.match(command, /write-public-client-config\.mjs/);
  assert.match(command, /write-mac-local-proxy\.mjs/);
  assert.match(command, /verify-public-package-artifacts\.mjs/);
  assert.doesNotMatch(command, /inject-client-config\.mjs/);
});

test('package scripts build universal Mac and x64 Windows clients with explicit platform icon files', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

  assert.match(packageJson.scripts['package:mac'], /--icon=assets\/ClipboardSync\.icns/);
  assert.match(packageJson.scripts['package:mac'], /--platform=darwin/);
  assert.match(packageJson.scripts['package:mac'], /--arch=universal/);
  assert.match(packageJson.scripts['package:mac'], /\\\.local/);
  assert.match(packageJson.scripts['package:mac'], /AGENTS\.md/);
  assert.doesNotMatch(packageJson.scripts['package:mac'], /--arch=arm64/);
  assert.match(packageJson.scripts['package:win'], /--icon=assets\/ClipboardSync\.ico/);
  assert.match(packageJson.scripts['package:win'], /--arch=x64/);
  assert.match(packageJson.scripts['package:win'], /\\\.local/);
  assert.match(packageJson.scripts['package:win'], /AGENTS\.md/);
});

test('package scripts expose fixed Mac and Windows smoke commands', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

  assert.equal(packageJson.scripts['smoke:mac-package'], 'node scripts/smoke-mac-package.mjs');
  assert.match(packageJson.scripts['smoke:windows-package'], /powershell\.exe/);
  assert.match(packageJson.scripts['smoke:windows-package'], /-STA/);
  assert.match(packageJson.scripts['smoke:windows-package'], /scripts\\smoke-windows-package\.ps1/);
});

test('verify:package checks package artifacts and the release manifest', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

  assert.match(packageJson.scripts['verify:package'], /verify-package-artifacts\.mjs/);
  assert.match(packageJson.scripts['verify:package'], /verify-release-manifest\.mjs/);
  assert.match(packageJson.scripts['verify:release'], /verify-public-package-artifacts\.mjs/);
  assert.match(packageJson.scripts['verify:release'], /verify-release-manifest\.mjs/);
});

test('Mac packaging declares local network access for LAN hub connections', async () => {
  const script = await readFile('scripts/fix-mac-plist.mjs', 'utf8');

  assert.match(script, /NSLocalNetworkUsageDescription/);
  assert.match(script, /clipboard hub and nearby devices/);
});

test('verify:ui captures both light and dark themes', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

  assert.equal(packageJson.scripts['verify:ui'], 'node scripts/verify-ui.mjs');
  assert.doesNotMatch(packageJson.scripts['qa:screenshot'], /CLIPBOARD_SYNC_QA_/);
  assert.doesNotMatch(packageJson.scripts['qa:screenshot:fixture'], /CLIPBOARD_SYNC_QA_/);

  const verifyScript = await readFile('scripts/verify-ui.mjs', 'utf8');
  assert.match(verifyScript, /for \(const theme of \['light', 'dark'\]\)/);
  assert.match(verifyScript, /CLIPBOARD_SYNC_QA_THEME: theme/);
  assert.match(verifyScript, /CLIPBOARD_SYNC_DISABLE_AUTO_LAUNCH: '1'/);
  assert.match(verifyScript, /timeoutMs/);
  assert.match(verifyScript, /SIGKILL/);
});

test('verify:ui keeps themed artifacts and asserts rendered UI markers', async () => {
  const main = await readFile('src/client/electron-main.js', 'utf8');
  const assertScript = await readFile('scripts/assert-qa-screenshots.mjs', 'utf8');

  assert.match(main, /ui-main-\$\{theme\}\.png/);
  assert.match(main, /ui-history-\$\{theme\}\.png/);
  assert.match(main, /ui-qa-\$\{theme\}\.json/);
  assert.match(main, /document\.querySelectorAll\('thead th'\)/);
  assert.match(main, /document\.querySelectorAll\('\.history-item'\)/);
  assert.match(main, /windowProfile/);
  assert.match(main, /imageTagCount/);
  assert.match(main, /pinControl/);
  assert.match(main, /document\.documentElement\.scrollWidth/);
  assert.match(main, /connectionOpen/);
  assert.match(main, /connectionFields/);
  assert.match(main, /ignoreFields/);
  assert.match(main, /clearHistoryButton/);
  assert.match(assertScript, /Hub URL field visibility/);
  assert.match(assertScript, /recent source list visibility/);
  assert.match(assertScript, /ignored source field visibility/);
  assert.match(assertScript, /clear global history button visibility/);
  assert.match(assertScript, /clear global history button text/);
  assert.match(assertScript, /main panel viewport height/);
  assert.match(main, /document\.querySelectorAll\('\.history-preview-text'\)/);
  assert.match(main, /historyEntryKind/);
  assert.match(main, /mainWindowEntryLabel/);
  assert.match(main, /waitForWindowReady/);
  assert.match(assertScript, /native history entry kind/);
  assert.match(assertScript, /native main window entry label/);
  assert.match(assertScript, /main window should stay always on top/);
  assert.match(main, /trayMenuBuilt: true/);
  assert.match(main, /hubStartAttempted: !qaFixtureMode/);
  assert.match(main, /syncServiceStarted: !qaFixtureMode/);
  assert.match(main, /CLIPBOARD_SYNC_QA_CAPTURE === '1' \\|\\| installSingleInstanceGuard/);
  assert.match(main, /CLIPBOARD_SYNC_QA_DIRECT_PASTE/);
  assert.match(main, /CLIPBOARD_SYNC_QA_DIRECT_PASTE_SHOW_HISTORY_AFTER_CAPTURE/);
  assert.match(main, /writeQaDirectPasteResult/);
  assert.match(main, /CLIPBOARD_SYNC_USER_DATA_DIR/);
  assert.match(assertScript, /ui-main-\$\{theme\}\.png/);
  assert.match(assertScript, /ui-history-\$\{theme\}\.png/);
  assert.match(assertScript, /ui-qa-\$\{theme\}\.json/);
  assert.match(assertScript, /assertDeepEqual\(report\.main\.headers, \['IP', '发送', '接收'\]/);
  assert.match(assertScript, /assertEqual\(report\.history\.itemCount, 30/);
  assert.match(assertScript, /assertNoHorizontalOverflow\(report\.history\.viewport, 'history panel'\)/);
  assert.match(assertScript, /imagePlaceholderTexts/);
  assert.match(assertScript, /real image thumbnail/);
  assert.match(assertScript, /history always-on-top control contrast/);
});
