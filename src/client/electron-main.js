import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, screen, Tray } from 'electron';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ElectronClipboardAdapter } from './clipboard-adapter.js';
import { readClipboardSource } from './clipboard-source.js';
import { bootstrapConfigPaths } from './bootstrap-paths.js';
import { hashEventPayload } from './clipboard-content.js';
import { ConfigStore, normalizeHistoryDisplayLimit } from './config-store.js';
import {
  isRecentPasteTarget,
  pasteIntoMacTarget,
  pasteIntoWindowsTarget,
  readMacForegroundTarget,
  readWindowsForegroundTarget
} from './direct-paste.js';
import { disableElectronSafeStorageKeychain, safeStorageKeychainSuppressionState } from './electron-safe-storage.js';
import { shouldRefreshHistoryOnStatus } from './history-refresh-policy.js';
import { historyEventForSelection } from './history-selection.js';
import { HubClient } from './hub-client.js';
import i18n from './i18n.cjs';
import { loginItemSettingsFor } from './login-item-settings.js';
import { MacLocalProxyManager } from './mac-local-proxy.js';
import { ClipboardLoopGuard } from './loop-guard.js';
import { menuSafeLabel } from './menu-labels.js';
import { nextPasteTargetMemory, pasteTargetMemoryAction } from './paste-target-memory.js';
import { filterVisibleHistory, mergeDeviceRules, mergeDeviceRulesByIp, updateDeviceRule } from './policy.js';
import { applyQaThemeSource } from './qa-theme.js';
import { normalizeHubUrl } from './settings-validation.js';
import { installSingleInstanceGuard } from './single-instance.js';
import { mergeRecentSourceSuggestions } from './source-suggestions.js';
import { popupActionFor, shouldHidePopupOnBlur, shouldShowInitialPopup } from './startup-window-policy.js';
import { ClipboardSyncService } from './sync-service.js';
import {
  deviceSettingsMenuLabel,
  historyMenuEntryForPlatform,
  historyMenuIconForEvent,
  languageMenuEntry
} from './tray-menu-template.js';
import { trayIconForPlatform } from './tray-icon.js';
import { uiHistoryEvent } from './ui-history-event.js';
import { createUiLifecycle } from './ui-lifecycle.js';
import { popupPosition } from './window-position.js';

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const POPUP_WIDTH = isWindows ? 460 : 420;
const POPUP_HEIGHT = isWindows ? 760 : 680;
const HISTORY_WIDTH = isWindows ? 720 : 520;
const HISTORY_HEIGHT = isWindows ? 640 : 640;
const MAC_TRAY_ICON_PATH = join(APP_ROOT, 'src/client/tray-icon.png');
const WINDOWS_TRAY_ICON_PATH = join(APP_ROOT, 'src/client/tray-icon-win.png');
const QA_FIXTURE_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP8z8AARQAFAAHeAitJAAAAAElFTkSuQmCC';
const QA_FIXTURE_IMAGE_PLACEHOLDER = Buffer.from('not-a-renderable-image').toString('base64');
const disableAutoLaunchRegistration = process.env.CLIPBOARD_SYNC_DISABLE_AUTO_LAUNCH === '1';
const userDataDir = process.env.CLIPBOARD_SYNC_USER_DATA_DIR;

disableElectronSafeStorageKeychain(app);

if (userDataDir) {
  app.setPath('userData', userDataDir);
}

let tray;
let popup;
let historyPopup;
let configStore;
let hub;
let syncService;
let devices = [];
let history = [];
let status = { state: 'starting' };
let recentSources = [];
let qaFixtureMode = false;
let lastExternalPasteTarget = null;
let pasteTargetSampler = null;
let macLocalProxy = null;
let hubConnectionSettings = null;
const uiHistoryEventCache = new Map();
const historyMenuIconCache = new Map();
const uiLifecycle = createUiLifecycle();
const { normalizeLanguage, t } = i18n;

function statusLabel(state = status, language = configStore?.get?.().language) {
  const languageCode = normalizeLanguage(language);
  const keys = {
    connected: 'status.connected',
    disconnected: 'status.disconnected',
    'invalid-hub-url': 'status.invalidHubUrl',
    'duplicate-device': 'status.duplicateDevice',
    'connection-error': 'status.connectionError',
    'clipboard-error': 'status.clipboardError',
    'hub-error': 'status.hubError',
    starting: 'status.starting'
  };
  return t(languageCode, keys[state.state] || 'status.starting');
}

function trayIcon() {
  return trayIconForPlatform({ nativeImage, readFileSync, iconPath: isWindows ? WINDOWS_TRAY_ICON_PATH : MAC_TRAY_ICON_PATH });
}

function clearHistoryRenderCaches() {
  uiHistoryEventCache.clear();
  historyMenuIconCache.clear();
}

function visibleHistoryForUi(settings = configStore.get()) {
  return filterVisibleHistory(history, settings, normalizeHistoryDisplayLimit(settings.historyDisplayLimit));
}

function uiHistoryForSettings(settings = configStore.get()) {
  return visibleHistoryForUi(settings).map((event) => uiHistoryEvent(event, { nativeImage, cache: uiHistoryEventCache }));
}

function stateForUi() {
  const settings = configStore.get();
  const historyDisplayLimit = normalizeHistoryDisplayLimit(settings.historyDisplayLimit);
  return {
    status,
    settings: {
      ...settings,
      token: '',
      hasToken: Boolean(settings.token),
      historyDisplayLimit
    },
    devices,
    recentSources,
    history: uiHistoryForSettings(settings)
  };
}

async function syncHubConnectionSettings() {
  const settings = configStore.get();
  if (!macLocalProxy) {
    hubConnectionSettings = settings;
    return settings;
  }
  try {
    hubConnectionSettings = await macLocalProxy.sync(settings);
  } catch (error) {
    smokeTrace({ stage: 'mac-local-proxy-error', message: error.message });
    hubConnectionSettings = settings;
  }
  return hubConnectionSettings;
}

function currentHubSettings() {
  const settings = configStore.get();
  if (!hubConnectionSettings) {
    return settings;
  }
  return {
    ...settings,
    hubUrl: hubConnectionSettings.hubUrl,
    token: hubConnectionSettings.token
  };
}

function broadcastState() {
  if (!uiLifecycle.canBroadcast()) {
    return;
  }
  const state = stateForUi();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('client:state', state);
  }
  buildTrayMenu();
}

function setStatus(nextStatus) {
  status = nextStatus;
  broadcastState();
}

function applyLoginItemSettings(settings) {
  if (disableAutoLaunchRegistration) {
    return;
  }
  app.setLoginItemSettings(loginItemSettingsFor(settings));
}

async function refreshHistory() {
  if (qaFixtureMode) {
    broadcastState();
    return;
  }
  try {
    history = await hub.fetchHistory(normalizeHistoryDisplayLimit(configStore.get().historyDisplayLimit));
    broadcastState();
  } catch {
    // Status is already represented by the websocket state; history refresh can fail transiently.
  }
}

async function clearHistory() {
  try {
    if (!qaFixtureMode) {
      await hub.clearHistory();
    }
    history = [];
    clearHistoryRenderCaches();
    broadcastState();
    return { cleared: true };
  } catch (error) {
    setStatus({ state: 'hub-error', message: error.message });
    return { cleared: false, error: error.message };
  }
}

async function writeReadyMarker(details = {}) {
  const readyFile = process.env.CLIPBOARD_SYNC_READY_FILE;
  if (!readyFile) {
    return;
  }
  await mkdir(dirname(readyFile), { recursive: true });
  await writeFile(
    readyFile,
    `${JSON.stringify(
      {
        status: 'ready',
        platform: process.platform,
        pid: process.pid,
        generatedAt: new Date().toISOString(),
        ...details
      },
      null,
      2
    )}\n`
  );
}

function smokeTrace(event) {
  const traceFile = process.env.CLIPBOARD_SYNC_TRACE_FILE;
  if (!traceFile) {
    return;
  }
  appendFile(traceFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...event })}\n`).catch(() => {});
}

function rememberClipboardSource({ source }) {
  const nextSources = mergeRecentSourceSuggestions(recentSources, source);
  if (JSON.stringify(nextSources) === JSON.stringify(recentSources)) {
    return;
  }
  recentSources = nextSources;
  broadcastState();
}

function isAccessibilityPermissionError(error) {
  return /accessibility permission required/i.test(`${error?.message || ''}\n${error?.stderr || ''}`);
}

function pasteTargetTrace(target) {
  if (!target) {
    return null;
  }
  return {
    platform: target.platform,
    pid: target.pid,
    hwnd: target.hwnd,
    className: target.className,
    processName: target.processName,
    title: target.title,
    bundleId: target.bundleId,
    name: target.name,
    role: target.role,
    subrole: target.subrole,
    roleDescription: target.roleDescription,
    focusState: target.focusState,
    canPaste: target.canPaste,
    capturedAt: target.capturedAt
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForClipboardEvent(event, { timeoutMs = 1_500, intervalMs = 60 } = {}) {
  const hash = hashEventPayload(event);
  const deadline = Date.now() + timeoutMs;
  do {
    const actual = syncService.readSnapshot();
    if (actual.ok && syncService.clipboardContainsEvent(event, hash, actual.snapshot)) {
      return true;
    }
    await wait(intervalMs);
  } while (Date.now() < deadline);
  return false;
}

async function captureExternalPasteTarget() {
  if (!isWindows && !isMac) {
    return null;
  }
  const reader = isWindows ? readWindowsForegroundTarget : readMacForegroundTarget;
  try {
    const target = await reader();
    const action = pasteTargetMemoryAction(target, { isMac, isWindows, ownPid: process.pid });
    lastExternalPasteTarget = nextPasteTargetMemory(lastExternalPasteTarget, target, { isMac, isWindows, ownPid: process.pid });
    smokeTrace({
      stage: 'paste-target-capture',
      action,
      target: pasteTargetTrace(target),
      remembered: pasteTargetTrace(lastExternalPasteTarget)
    });
    return action === 'update' ? lastExternalPasteTarget : null;
  } catch (error) {
    smokeTrace({ stage: 'paste-target-capture-error', message: error.message });
    return null;
  }
}

function rememberExternalPasteTarget() {
  captureExternalPasteTarget();
}

function startPasteTargetSampler() {
  if (pasteTargetSampler || (!isMac && !isWindows)) {
    return;
  }
  pasteTargetSampler = setInterval(() => {
    captureExternalPasteTarget();
  }, isMac ? 900 : 1_200);
  pasteTargetSampler.unref?.();
}

function stopPasteTargetSampler() {
  clearInterval(pasteTargetSampler);
  pasteTargetSampler = null;
}

async function writeQaDirectPasteResult(result) {
  const resultFile = process.env.CLIPBOARD_SYNC_QA_DIRECT_PASTE_RESULT_FILE;
  if (!resultFile) {
    return;
  }
  await mkdir(dirname(resultFile), { recursive: true });
  await writeFile(
    resultFile,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        ...result
      },
      null,
      2
    )}\n`
  );
}

async function runQaDirectPasteSmoke() {
  if (process.env.CLIPBOARD_SYNC_QA_DIRECT_PASTE !== '1') {
    return false;
  }

  const delayMs = Number.parseInt(process.env.CLIPBOARD_SYNC_QA_DIRECT_PASTE_DELAY_MS || '800', 10);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await wait(delayMs);
  }

  if (process.env.CLIPBOARD_SYNC_QA_DIRECT_PASTE_SHOW_HISTORY_AFTER_CAPTURE === '1') {
    await captureExternalPasteTarget();
    showHistoryPopup();
    await waitForWindowReady(historyPopup, 'main window');
    await wait(300);
    await captureExternalPasteTarget();
  } else {
    await captureExternalPasteTarget();
  }

  const result = await applyHistory(process.env.CLIPBOARD_SYNC_QA_DIRECT_PASTE_EVENT_ID || 'qa-history-23', {
    paste: true
  });
  await writeQaDirectPasteResult({
    ...result,
    targetCaptured: Boolean(lastExternalPasteTarget),
    target: pasteTargetTrace(lastExternalPasteTarget)
  });
  app.quit();
  return true;
}

function historyMenuItems() {
  const language = normalizeLanguage(configStore.get().language);
  const visible = uiHistoryForSettings();
  if (visible.length === 0) {
    return [{ label: t(language, 'history.none'), enabled: false }];
  }
  return visible.map((event) => {
    const source = event.sourceIp || event.sourceDeviceId || t(language, 'devices.unknownIp');
    const preview = event.contentType?.startsWith('image/') && event.preview === t('zh-CN', 'history.image')
      ? t(language, 'history.image')
      : event.preview;
    const item = {
      label: menuSafeLabel(`${source} ${preview || ''}`.trim()),
      click: () => applyHistory(event.id, { paste: true })
    };
    const icon = historyMenuIconForEvent(event, nativeImage, undefined, historyMenuIconCache);
    if (icon) {
      item.icon = icon;
    }
    return item;
  });
}

function buildTrayMenu() {
  if (!uiLifecycle.canUseTray(tray)) {
    return;
  }
  const settings = configStore.get();
  const language = normalizeLanguage(settings.language);
  const statusDetail = status.message ? [{ label: menuSafeLabel(status.message), enabled: false }] : [];
  const template = [
    { label: `${t(language, 'menu.statusPrefix')}${statusLabel(status, language)}`, enabled: false },
    ...statusDetail,
    { label: deviceSettingsMenuLabel(language), click: () => showPopup({ forceShow: true }) },
    historyMenuEntryForPlatform(process.platform, historyMenuItems, () => showHistoryPopup(), language),
    { type: 'separator' },
    {
      label: t(language, 'settings.pauseSend'),
      type: 'checkbox',
      checked: settings.pauseSend,
      click: (item) => updateSettings({ pauseSend: item.checked })
    },
    {
      label: t(language, 'settings.pauseReceive'),
      type: 'checkbox',
      checked: settings.pauseReceive,
      click: (item) => updateSettings({ pauseReceive: item.checked })
    },
    {
      label: t(language, 'settings.autoLaunch'),
      type: 'checkbox',
      checked: settings.autoLaunch,
      click: (item) => updateSettings({ autoLaunch: item.checked })
    },
    languageMenuEntry(language, (nextLanguage) => updateSettings({ language: nextLanguage })),
    { type: 'separator' },
    { label: t(language, 'action.quit'), click: () => app.quit() }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function applyHistoryAlwaysOnTop() {
  if (!historyPopup) {
    return;
  }
  historyPopup.setAlwaysOnTop(Boolean(configStore.get().historyAlwaysOnTop), 'floating');
}

function positionNearTray(window, width, height) {
  const { x, y } = popupPosition({
    platform: process.platform,
    trayBounds: tray?.getBounds?.(),
    displays: screen.getAllDisplays(),
    primaryDisplay: screen.getPrimaryDisplay(),
    width,
    height
  });
  window.setBounds({ x, y, width, height });
}

function createPopupWindow({ width, height, file, windowRole = 'tray-panel' }) {
  const isHistoryMain = windowRole === 'history-main';
  const isDark = nativeTheme.shouldUseDarkColors;
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    center: isHistoryMain,
    title: isHistoryMain ? 'Clipboard Sync' : undefined,
    resizable: isHistoryMain,
    minimizable: isHistoryMain,
    maximizable: isHistoryMain,
    fullscreenable: isHistoryMain,
    frame: isHistoryMain,
    roundedCorners: !isHistoryMain,
    skipTaskbar: !isHistoryMain,
    alwaysOnTop: isHistoryMain ? Boolean(configStore?.get?.().historyAlwaysOnTop) : true,
    backgroundColor: process.platform === 'darwin' ? '#00000000' : isDark ? '#1f242d' : '#f6f7f9',
    vibrancy: !isHistoryMain && process.platform === 'darwin' ? 'popover' : undefined,
    visualEffectState: !isHistoryMain && process.platform === 'darwin' ? 'active' : undefined,
    webPreferences: {
      preload: join(APP_ROOT, 'src/client/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  let hasFocused = false;
  window.on('focus', () => {
    hasFocused = true;
  });
  window.on('blur', () => {
    if (isHistoryMain) {
      setTimeout(rememberExternalPasteTarget, 120);
    }
    if (shouldHidePopupOnBlur({ hasFocused, devToolsOpened: window.webContents.isDevToolsOpened(), windowRole })) {
      window.hide();
    }
  });
  window.loadFile(join(APP_ROOT, file));
  return window;
}

function waitForWindowReady(window, label, timeoutMs = 10_000) {
  if (!window.webContents.isLoading()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} did not finish loading within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      window.webContents.off('did-finish-load', onDone);
      window.webContents.off('did-fail-load', onFailed);
      window.webContents.off('render-process-gone', onGone);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onFailed = (_event, errorCode, errorDescription) => {
      cleanup();
      reject(new Error(`${label} failed to load: ${errorCode} ${errorDescription}`));
    };
    const onGone = (_event, details) => {
      cleanup();
      reject(new Error(`${label} renderer exited: ${details.reason}`));
    };
    window.webContents.once('did-finish-load', onDone);
    window.webContents.once('did-fail-load', onFailed);
    window.webContents.once('render-process-gone', onGone);
  });
}

function showPopup({ forceShow = false } = {}) {
  if (!popup) {
    popup = createPopupWindow({ width: POPUP_WIDTH, height: POPUP_HEIGHT, file: 'src/client/ui.html' });
    popup.on('closed', () => {
      popup = null;
    });
  }

  if (popupActionFor({ isVisible: popup.isVisible(), forceShow }) === 'hide') {
    popup.hide();
    return;
  }

  positionNearTray(popup, POPUP_WIDTH, POPUP_HEIGHT);
  refreshHistory();
  popup.show();
  popup.focus();
}

function showHistoryPopup() {
  if (!historyPopup) {
    historyPopup = createPopupWindow({
      width: HISTORY_WIDTH,
      height: HISTORY_HEIGHT,
      file: 'src/client/history.html',
      windowRole: 'history-main'
    });
    historyPopup.on('closed', () => {
      historyPopup = null;
    });
  }

  refreshHistory();
  applyHistoryAlwaysOnTop();
  if (historyPopup.isMinimized()) {
    historyPopup.restore();
  }
  historyPopup.show();
  historyPopup.focus();
}

async function updateSettings(patch) {
  const normalizedPatch = { ...patch };
  for (const key of ['pauseSend', 'pauseReceive', 'autoLaunch', 'historyAlwaysOnTop']) {
    if (key in normalizedPatch) {
      normalizedPatch[key] = Boolean(normalizedPatch[key]);
    }
  }
  if ('token' in normalizedPatch && typeof normalizedPatch.token !== 'string') {
    delete normalizedPatch.token;
  }
  if ('hubUrl' in normalizedPatch) {
    try {
      normalizedPatch.hubUrl = normalizeHubUrl(normalizedPatch.hubUrl);
    } catch (error) {
      setStatus({ state: 'invalid-hub-url', message: error.message });
      return stateForUi();
    }
  }
  if ('ignoredSourcePatterns' in normalizedPatch) {
    normalizedPatch.ignoredSourcePatterns = Array.isArray(normalizedPatch.ignoredSourcePatterns)
      ? normalizedPatch.ignoredSourcePatterns
      : String(normalizedPatch.ignoredSourcePatterns || '').split(/\r?\n/);
  }

  const settings = await configStore.update(normalizedPatch);
  if ('historyAlwaysOnTop' in normalizedPatch) {
    applyHistoryAlwaysOnTop();
  }
  applyLoginItemSettings(settings);
  hub.sendReceiverPolicy(settings);
  broadcastState();
  if ('token' in normalizedPatch || 'hubUrl' in normalizedPatch || 'deviceId' in normalizedPatch || 'deviceName' in normalizedPatch) {
    await syncHubConnectionSettings();
    hub.reconnectNow();
  }
  return stateForUi();
}

async function updateRule(deviceId, column, checked) {
  if (column !== 'send' && column !== 'receive') {
    return stateForUi();
  }
  const settings = configStore.get();
  await updateSettings(updateDeviceRule(settings, devices, deviceId, column, checked));
  return stateForUi();
}

async function applyHistory(eventId, { paste = false } = {}) {
  const settings = configStore.get();
  const event = historyEventForSelection(history, settings, eventId, normalizeHistoryDisplayLimit(settings.historyDisplayLimit));
  if (event) {
    const hash = hashEventPayload(event);
    const wroteImmediately = syncService.applyHistoryEvent(event);
    const clipboardReady = wroteImmediately || (paste ? await waitForClipboardEvent(event) : false);
    smokeTrace({
      stage: 'history-clipboard-ready',
      ready: clipboardReady,
      wroteImmediately,
      contentType: event.contentType,
      sourceDeviceId: event.sourceDeviceId,
      hash
    });
    if (paste && (isWindows || isMac) && isRecentPasteTarget(lastExternalPasteTarget)) {
      if (!clipboardReady) {
        return { applied: true, pasted: false };
      }
      smokeTrace({ stage: 'history-paste-attempt', target: pasteTargetTrace(lastExternalPasteTarget) });
      let pasteError = null;
      const pasted = isWindows
        ? await pasteIntoWindowsTarget(lastExternalPasteTarget, {
            ownPid: process.pid,
            onError: (error) => {
              pasteError = error;
              smokeTrace({ stage: 'history-paste-error', message: error.message });
            }
          })
        : await pasteIntoMacTarget(lastExternalPasteTarget, {
            ownPid: process.pid,
            onError: (error) => {
              pasteError = error;
              smokeTrace({ stage: 'history-paste-error', message: error.message });
            }
          });
      smokeTrace({ stage: 'history-paste-result', pasted, target: pasteTargetTrace(lastExternalPasteTarget) });
      if (pasted) {
        return { applied: true, pasted: true };
      }
      if (isAccessibilityPermissionError(pasteError)) {
        return { applied: true, pasted: false, permissionRequired: true };
      }
    }
    if (paste && (isWindows || isMac)) {
      if (!clipboardReady) {
        return { applied: true, pasted: false };
      }
      const pasteTarget = await captureExternalPasteTarget();
      if (isRecentPasteTarget(pasteTarget)) {
        smokeTrace({ stage: 'history-paste-attempt', fallback: true, target: pasteTargetTrace(pasteTarget) });
        let pasteError = null;
        const pasted = isWindows
          ? await pasteIntoWindowsTarget(pasteTarget, {
              ownPid: process.pid,
              onError: (error) => {
                pasteError = error;
                smokeTrace({ stage: 'history-paste-error', fallback: true, message: error.message });
              }
            })
          : await pasteIntoMacTarget(pasteTarget, {
              ownPid: process.pid,
              onError: (error) => {
                pasteError = error;
                smokeTrace({ stage: 'history-paste-error', fallback: true, message: error.message });
              }
            });
        smokeTrace({ stage: 'history-paste-result', fallback: true, pasted, target: pasteTargetTrace(pasteTarget) });
        if (pasted) {
          return { applied: true, pasted: true };
        }
        if (isAccessibilityPermissionError(pasteError)) {
          return { applied: true, pasted: false, permissionRequired: true };
        }
      }
    }
    return { applied: true, pasted: false };
  }
  return { applied: false, pasted: false };
}

function installQaFixtureState() {
  if (process.env.CLIPBOARD_SYNC_QA_FIXTURE !== '1') {
    return false;
  }

  const settings = configStore.get();
  settings.deviceRules = {
    'main-pc': { send: false, receive: true },
    'main-pc-portable': { send: true, receive: true },
    'mac-mini': { send: false, receive: true },
    'mini-pc': { send: true, receive: false }
  };
  devices = [
    { deviceId: settings.deviceId, deviceName: settings.deviceName, ip: '192.0.2.12', connectedAt: '2026-06-01T00:00:00.000Z' },
    { deviceId: 'main-pc', deviceName: 'Main PC', ip: '192.0.2.20', connectedAt: '2026-06-01T00:01:00.000Z' },
    { deviceId: 'main-pc-portable', deviceName: 'Main PC portable', ip: '192.0.2.20', connectedAt: '2026-06-01T00:01:30.000Z' },
    { deviceId: 'mac-mini', deviceName: 'Mac mini', ip: '192.0.2.21', connectedAt: '2026-06-01T00:02:00.000Z' },
    { deviceId: 'mini-pc', deviceName: 'Mini PC', ip: '192.0.2.22', connectedAt: '2026-06-01T00:03:00.000Z' }
  ];
  history = Array.from({ length: 36 }, (_, index) => {
    const source = index % 3 === 0 ? devices[1] : index % 3 === 1 ? devices[2] : devices[3];
    const isImage = index % 5 === 4;
    const forcePlaceholder = isImage && index % 10 === 4;
    const content = isImage
      ? forcePlaceholder
        ? QA_FIXTURE_IMAGE_PLACEHOLDER
        : QA_FIXTURE_IMAGE
      : `第 ${index + 1} 条复制内容，来自 ${source.ip}`;
    const event = {
      id: `qa-history-${index}`,
      type: 'clipboard.update',
      sourceDeviceId: source.deviceId,
      sourceIp: source.ip,
      contentType: isImage ? 'image/png' : 'text/plain',
      encoding: isImage ? 'base64' : 'utf8',
      content,
      byteLength: isImage ? Buffer.from(content, 'base64').length : Buffer.from(content, 'utf8').length,
      sequence: index + 1,
      createdAt: new Date(Date.UTC(2026, 5, 1, 0, index)).toISOString()
    };
    return { ...event, sha256: hashEventPayload(event) };
  });
  status = { state: 'connected' };
  recentSources = [
    {
      id: 'processname:dictationhelper',
      label: 'DictationHelper',
      pattern: 'DictationHelper',
      detail: '窗口：正在听写'
    }
  ];
  return true;
}

async function main() {
  app.setName('Clipboard Sync');
  await app.whenReady();
  applyQaThemeSource(nativeTheme);
  Menu.setApplicationMenu(null);

  configStore = new ConfigStore(app, {
    bootstrapPaths: bootstrapConfigPaths({ appRoot: APP_ROOT })
  });
  await configStore.load();
  macLocalProxy =
    isMac && app.isPackaged
      ? new MacLocalProxyManager({
          resourcesPath: process.resourcesPath,
          userDataPath: app.getPath('userData')
        })
      : null;
  await syncHubConnectionSettings();
  applyLoginItemSettings(configStore.get());

  tray = new Tray(trayIcon());
  tray.setToolTip('Clipboard Sync');
  startPasteTargetSampler();
  tray.on('click', () => {
    if (isMac) {
      rememberExternalPasteTarget();
      return;
    }
    showPopup();
  });

  hub = new HubClient(() => currentHubSettings());
  hub.on('status', (nextStatus) => {
    smokeTrace({
      stage: 'hub-status',
      state: nextStatus.state,
      message: nextStatus.message
    });
    setStatus(nextStatus);
    if (shouldRefreshHistoryOnStatus(nextStatus)) {
      refreshHistory();
    }
  });
  hub.on('devices', async (nextDevices) => {
    smokeTrace({
      stage: 'hub-devices',
      count: nextDevices.length,
      ownPresent: nextDevices.some((device) => device.deviceId === configStore.get().deviceId)
    });
    devices = nextDevices;
    const settings = configStore.get();
    await configStore.update({
      deviceRules: mergeDeviceRules(settings.deviceRules, settings.deviceRulesByIp, devices),
      deviceRulesByIp: mergeDeviceRulesByIp(settings.deviceRulesByIp, devices, settings.deviceRules)
    });
    hub.sendReceiverPolicy(currentHubSettings());
    broadcastState();
  });
  hub.on('config', async (nextConfig) => {
    if (nextConfig?.historyDisplayLimit) {
      await configStore.update({ historyDisplayLimit: nextConfig.historyDisplayLimit });
      await refreshHistory();
      return;
    }
    broadcastState();
  });
  hub.on('clipboard', (event) => {
    smokeTrace({
      stage: 'hub-clipboard',
      contentType: event.contentType,
      sourceDeviceId: event.sourceDeviceId,
      targetDeviceIds: event.targetDeviceIds,
      hash: event.sha256
    });
    history.push(event);
    history = filterVisibleHistory(history, configStore.get(), normalizeHistoryDisplayLimit(configStore.get().historyDisplayLimit)).reverse();
    broadcastState();
  });
  hub.on('history-cleared', () => {
    history = [];
    clearHistoryRenderCaches();
    broadcastState();
  });
  hub.on('error', (error) => setStatus({ state: 'connection-error', message: error.message }));

  syncService = new ClipboardSyncService({
    clipboard: new ElectronClipboardAdapter(),
    hub,
    settingsProvider: () => configStore.get(),
    devicesProvider: () => devices,
    loopGuard: new ClipboardLoopGuard(),
    onError: (error) => {
      smokeTrace({ stage: 'clipboard-error', message: error.message });
      setStatus({ state: 'clipboard-error', message: error.message });
    },
    onTrace: smokeTrace,
    onSourceObserved: rememberClipboardSource,
    sourceProvider: () => readClipboardSource({ platform: process.platform })
  });

  ipcMain.handle('client:get-state', () => stateForUi());
  ipcMain.handle('client:update-rule', (_event, deviceId, column, checked) => updateRule(deviceId, column, checked));
  ipcMain.handle('client:update-setting', (_event, patch) => updateSettings(patch));
  ipcMain.handle('client:refresh', async () => {
    await hub.refreshDevices();
    await refreshHistory();
    return stateForUi();
  });
  ipcMain.handle('client:show-history', () => showHistoryPopup());
  ipcMain.handle('client:apply-history', (_event, eventId) => applyHistory(eventId, { paste: true }));
  ipcMain.handle('client:clear-history', () => clearHistory());
  ipcMain.handle('client:quit', () => app.quit());

  qaFixtureMode = installQaFixtureState();

  buildTrayMenu();
  if (!qaFixtureMode) {
    hub.start();
    syncService.start();
  }
  await writeReadyMarker({
    trayMenuBuilt: true,
    safeStorageKeychain: safeStorageKeychainSuppressionState(app),
    hubStartAttempted: !qaFixtureMode,
    syncServiceStarted: !qaFixtureMode
  });

  if (await runQaDirectPasteSmoke()) {
    return;
  }

  if (shouldShowInitialPopup({ platform: process.platform, firstRun: configStore.wasCreatedOnLoad() })) {
    showPopup({ forceShow: true });
  }

  if (process.env.CLIPBOARD_SYNC_QA_CAPTURE === '1') {
    await captureQaScreenshots();
  }
}

async function captureQaScreenshots() {
  const theme = process.env.CLIPBOARD_SYNC_QA_THEME === 'dark' ? 'dark' : 'light';
  const outputDir = process.env.CLIPBOARD_SYNC_QA_OUTPUT_DIR || join(APP_ROOT, 'tmp');
  const language = normalizeLanguage(configStore.get().language);
  const qaHistoryMenuEntry = historyMenuEntryForPlatform(process.platform, () => [], () => showHistoryPopup(), language);
  await mkdir(outputDir, { recursive: true });
  showPopup({ forceShow: true });
  await waitForWindowReady(popup, 'main panel');
  await popup.webContents.executeJavaScript(`document.querySelector('.connection')?.setAttribute('open', '')`);
  await popup.webContents.executeJavaScript(`document.querySelector('.ignore-rules')?.setAttribute('open', '')`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const mainReport = await popup.webContents.executeJavaScript(`({
    platform: ${JSON.stringify(process.platform)},
    language: ${JSON.stringify(language)},
    trayMainEntryLabel: ${JSON.stringify(deviceSettingsMenuLabel(language))},
    historyEntryKind: ${JSON.stringify(qaHistoryMenuEntry.submenu ? 'submenu' : 'popup')},
    mainWindowEntryLabel: ${JSON.stringify(qaHistoryMenuEntry.submenu?.[0]?.label || null)},
    title: document.querySelector('.title')?.textContent.trim(),
    status: document.querySelector('#status')?.textContent.trim(),
    headers: [...document.querySelectorAll('thead th')].map((item) => item.textContent.trim()),
    headerMetrics: [...document.querySelectorAll('thead th')].map((item) => ({
      text: item.textContent.trim(),
      clientWidth: item.clientWidth,
      scrollWidth: item.scrollWidth
    })),
    rows: [...document.querySelectorAll('#devices tr')].map((row) => [...row.children].map((cell) => cell.textContent.trim())),
    historyButtonHidden: document.querySelector('#historyButton')?.hidden ?? null,
    connectionOpen: Boolean(document.querySelector('.connection')?.open),
    connectionFields: Object.fromEntries(['hubUrl', 'token', 'saveConnection'].map((id) => {
      const element = document.querySelector('#' + id);
      const rect = element?.getBoundingClientRect();
      return [id, Boolean(rect && rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden')];
    })),
    ignoreFields: Object.fromEntries(['recentSources', 'ignoredSourcePatterns', 'saveIgnore'].map((id) => {
      const element = document.querySelector('#' + id);
      const rect = element?.getBoundingClientRect();
      return [id, Boolean(rect && rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden')];
    })),
    viewport: {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight
    }
  })`);
  mainReport.windowBounds = popup.getBounds();
  const mainImage = await popup.webContents.capturePage();
  await writeFile(join(outputDir, `ui-main-${theme}.png`), mainImage.toPNG());
  await writeFile(join(outputDir, 'ui-main.png'), mainImage.toPNG());
  showHistoryPopup();
  await waitForWindowReady(historyPopup, 'main window');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const historyReport = await historyPopup.webContents.executeJavaScript(`({
    title: document.querySelector('.title')?.textContent.trim(),
    subtitle: document.querySelector('.status')?.textContent.trim(),
    itemCount: document.querySelectorAll('.history-item').length,
    firstIp: document.querySelector('.history-ip')?.textContent.trim(),
    imageCount: document.querySelectorAll('.history-item img, .history-item .image-placeholder').length,
    imageTagCount: document.querySelectorAll('.history-item img').length,
    imagePreviewTexts: [...document.querySelectorAll('.history-preview-text')].map((item) => item.textContent.trim()),
    imagePlaceholderTexts: [...document.querySelectorAll('.image-placeholder')].map((item) => item.textContent.trim()),
    pinControl: (() => {
      const element = document.querySelector('.pin-control');
      const style = element ? getComputedStyle(element) : null;
      return element && style ? {
        text: element.textContent.trim(),
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        color: style.color
      } : null;
    })(),
    clearHistoryButton: (() => {
      const element = document.querySelector('#clearHistory');
      const rect = element?.getBoundingClientRect();
      return {
        visible: Boolean(rect && rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'),
        text: element?.textContent.trim()
      };
    })(),
    viewport: {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }
  })`);
  historyReport.windowBounds = historyPopup.getBounds();
  historyReport.windowProfile = {
    alwaysOnTop: historyPopup.isAlwaysOnTop(),
    resizable: historyPopup.isResizable(),
    minimizable: historyPopup.isMinimizable(),
    maximizable: historyPopup.isMaximizable()
  };
  const historyImage = await historyPopup.webContents.capturePage();
  await writeFile(join(outputDir, `ui-history-${theme}.png`), historyImage.toPNG());
  await writeFile(join(outputDir, 'ui-history.png'), historyImage.toPNG());
  await writeFile(join(outputDir, `ui-qa-${theme}.json`), `${JSON.stringify({ main: mainReport, history: historyReport }, null, 2)}\n`);
  popup.close();
  historyPopup.close();
  app.exit(0);
}

app.on('window-all-closed', (event) => {
  event?.preventDefault?.();
});

app.on('before-quit', () => {
  uiLifecycle.beginQuit();
  syncService?.stop();
  stopPasteTargetSampler();
  hub?.removeAllListeners();
  hub?.stop();
  macLocalProxy?.stop?.();
  tray?.destroy();
  tray = null;
});

if (process.env.CLIPBOARD_SYNC_QA_CAPTURE === '1' || installSingleInstanceGuard(app, () => {
  if (tray) {
    showPopup({ forceShow: true });
  }
})) {
  main().catch((error) => {
    console.error(error);
    app.quit();
  });
}
