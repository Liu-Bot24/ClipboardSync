import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { normalizeLanguage, t } = require('../src/client/i18n.cjs');
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const theme = process.env.CLIPBOARD_SYNC_QA_THEME === 'dark' ? 'dark' : 'light';
const language = normalizeLanguage(process.env.CLIPBOARD_CLIENT_LANGUAGE);
const expected = {
  mainTitle: t(language, 'app.sharedClipboard'),
  mainStatus: t(language, 'status.connected'),
  deviceSettingsLabel: t(language, 'menu.deviceSettings'),
  mainWindowLabel: t(language, 'history.mainWindow'),
  headers: ['IP', t(language, 'devices.send'), t(language, 'devices.receive')],
  historyTitle: t(language, 'app.mainWindow'),
  historySubtitle: t(language, 'history.latest', { limit: 30 }),
  imagePlaceholder: t(language, 'history.image'),
  alwaysOnTop: t(language, 'settings.alwaysOnTop'),
  clearGlobalHistory: t(language, 'history.clearGlobal')
};
const targets = [
  { name: 'main panel', path: join(projectRoot, `tmp/ui-main-${theme}.png`), minWidth: 400, minHeight: 400, minBytes: 20_000 },
  { name: 'history panel', path: join(projectRoot, `tmp/ui-history-${theme}.png`), minWidth: 400, minHeight: 480, minBytes: 20_000 }
];

function pngDimensions(buffer) {
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error('not a PNG file');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertAtLeast(actual, expected, label) {
  if (typeof actual !== 'number' || actual < expected) {
    throw new Error(`${label}: expected at least ${expected}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNoHorizontalOverflow(viewport, label) {
  if (!viewport || viewport.scrollWidth > viewport.clientWidth + 1) {
    throw new Error(`${label} horizontal overflow: ${JSON.stringify(viewport)}`);
  }
}

function assertNoTextClipping(items, label) {
  for (const item of items || []) {
    if (item.scrollWidth > item.clientWidth + 1) {
      throw new Error(`${label} clips ${JSON.stringify(item.text)}: ${JSON.stringify(item)}`);
    }
  }
}

function rgbChannels(value) {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(value || ''));
  if (!match) {
    return null;
  }
  return match.slice(1, 4).map((item) => Number.parseInt(item, 10));
}

function relativeLuminance(channels) {
  return channels
    .map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(foreground, background) {
  const foregroundRgb = rgbChannels(foreground);
  const backgroundRgb = rgbChannels(background);
  if (!foregroundRgb || !backgroundRgb) {
    return 0;
  }
  const lighter = Math.max(relativeLuminance(foregroundRgb), relativeLuminance(backgroundRgb));
  const darker = Math.min(relativeLuminance(foregroundRgb), relativeLuminance(backgroundRgb));
  return (lighter + 0.05) / (darker + 0.05);
}

for (const target of targets) {
  const info = await stat(target.path);
  if (info.size < target.minBytes) {
    throw new Error(`${target.name} screenshot is too small: ${info.size} bytes`);
  }

  const buffer = await readFile(target.path);
  const dimensions = pngDimensions(buffer);
  if (dimensions.width < target.minWidth || dimensions.height < target.minHeight) {
    throw new Error(
      `${target.name} screenshot dimensions are too small: ${dimensions.width}x${dimensions.height}`
    );
  }

  console.log(`${target.name}: ${dimensions.width}x${dimensions.height}, ${info.size} bytes`);
}

const report = JSON.parse(await readFile(join(projectRoot, `tmp/ui-qa-${theme}.json`), 'utf8'));
assertEqual(report.main.language, language, 'main report language');
assertEqual(report.main.title, expected.mainTitle, 'main title');
assertEqual(report.main.status, expected.mainStatus, 'main status');
assertEqual(report.main.trayMainEntryLabel, expected.deviceSettingsLabel, 'native device entry label');
assertEqual(report.main.historyEntryKind, process.platform === 'darwin' ? 'submenu' : 'popup', 'native history entry kind');
assertEqual(report.main.mainWindowEntryLabel, process.platform === 'darwin' ? expected.mainWindowLabel : null, 'native main window entry label');
assertAtLeast(report.main.viewport?.clientWidth, process.platform === 'win32' ? 440 : 400, 'main panel viewport width');
assertAtLeast(report.main.viewport?.clientHeight, process.platform === 'win32' ? 600 : 520, 'main panel viewport height');
assertEqual(report.main.connectionOpen, true, 'connection section capture state');
assertEqual(report.main.connectionFields?.hubUrl, true, 'Hub URL field visibility');
assertEqual(report.main.connectionFields?.token, true, 'token field visibility');
assertEqual(report.main.connectionFields?.saveConnection, true, 'connection save button visibility');
assertEqual(report.main.ignoreFields?.recentSources, true, 'recent source list visibility');
assertEqual(report.main.ignoreFields?.ignoredSourcePatterns, true, 'ignored source field visibility');
assertEqual(report.main.ignoreFields?.saveIgnore, true, 'ignored source save button visibility');
assertDeepEqual(report.main.headers, expected.headers, 'device table headers');
assertNoTextClipping(report.main.headerMetrics, 'device table header');
assertEqual(report.main.rows.length, 3, 'device table row count');
assertEqual(report.main.historyButtonHidden, process.platform === 'darwin', 'platform history button visibility');
assertNoHorizontalOverflow(report.main.viewport, 'main panel');
assertEqual(report.history.title, expected.historyTitle, 'main window title');
assertEqual(report.history.subtitle, expected.historySubtitle, 'main window subtitle');
assertEqual(report.history.windowProfile?.alwaysOnTop, true, 'main window should stay always on top');
assertEqual(report.history.windowProfile?.resizable, true, 'main window should be resizable');
assertEqual(report.history.windowProfile?.minimizable, true, 'main window should be minimizable');
assertEqual(report.history.itemCount, 30, 'history item count');
if (!/^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[0-1])\.|192\.0\.2\.)/.test(report.history.firstIp || '')) {
  throw new Error(`history first IP is not a LAN or fixture IP: ${report.history.firstIp}`);
}
if (report.history.imageCount < 1) {
  throw new Error('history report did not include image preview rows');
}
if (report.history.imageTagCount < 1) {
  throw new Error('history report did not include a real image thumbnail');
}
if (report.history.imagePreviewTexts?.some((text) => /(图片|Image)\s*·|\d+\s*(B|KB|MB)/i.test(text))) {
  throw new Error(`history image rows should not show type/size metadata: ${report.history.imagePreviewTexts.join(', ')}`);
}
if (!report.history.imagePlaceholderTexts?.includes(expected.imagePlaceholder)) {
  throw new Error(`history report did not include ${expected.imagePlaceholder} placeholder text for non-inline image previews`);
}
if (report.history.pinControl?.text !== expected.alwaysOnTop) {
  throw new Error(`history always-on-top control missing: ${JSON.stringify(report.history.pinControl)}`);
}
if (contrastRatio(report.history.pinControl?.color, report.history.pinControl?.backgroundColor) < 3) {
  throw new Error(`history always-on-top control contrast is too low: ${JSON.stringify(report.history.pinControl)}`);
}
assertEqual(report.history.clearHistoryButton?.visible, true, 'clear global history button visibility');
assertEqual(report.history.clearHistoryButton?.text, expected.clearGlobalHistory, 'clear global history button text');
assertNoHorizontalOverflow(report.history.viewport, 'history panel');
