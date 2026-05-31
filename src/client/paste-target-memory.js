import { isUsablePasteTarget } from './direct-paste.js';

export const IGNORED_MAC_PASTE_TARGET_BUNDLE_IDS = new Set([
  'dev.liuqi.clipboardsync',
  'com.apple.ControlCenter',
  'com.apple.Dock',
  'com.apple.notificationcenterui',
  'com.apple.systemuiserver'
]);

export const NON_PASTE_MAC_TARGET_BUNDLE_IDS = new Set(['com.apple.finder']);
export const IGNORED_WINDOWS_PASTE_TARGET_CLASS_NAMES = new Set(['Shell_TrayWnd', 'NotifyIconOverflowWindow', 'Progman', 'WorkerW']);

export function pasteTargetMemoryAction(target, { isMac = false, isWindows = false, ownPid = process.pid } = {}) {
  if (!target) {
    return 'keep';
  }
  if (target.pid === ownPid) {
    return 'keep';
  }
  if (isMac && IGNORED_MAC_PASTE_TARGET_BUNDLE_IDS.has(target.bundleId)) {
    return 'keep';
  }
  if (isMac && NON_PASTE_MAC_TARGET_BUNDLE_IDS.has(target.bundleId)) {
    return 'clear';
  }
  if (isWindows && IGNORED_WINDOWS_PASTE_TARGET_CLASS_NAMES.has(target.className)) {
    return 'keep';
  }
  if (!isUsablePasteTarget(target, ownPid)) {
    return 'clear';
  }
  return 'update';
}

export function nextPasteTargetMemory(currentTarget, target, { isMac = false, isWindows = false, ownPid = process.pid, now = Date.now } = {}) {
  const action = pasteTargetMemoryAction(target, { isMac, isWindows, ownPid });
  if (action === 'update') {
    return { ...target, capturedAt: now() };
  }
  if (action === 'clear') {
    return null;
  }
  return currentTarget ?? null;
}
