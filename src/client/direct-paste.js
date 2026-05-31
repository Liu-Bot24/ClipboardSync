import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const PASTE_TARGET_TTL_MS = 30_000;
export const MAC_FRONTMOST_ONLY_PASTE_TARGET_BUNDLE_IDS = new Set(['com.apple.Notes']);

const foregroundTargetScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ClipboardSyncNative {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
}
"@

$hwnd = [ClipboardSyncNative]::GetForegroundWindow()
$windowProcessId = 0
[ClipboardSyncNative]::GetWindowThreadProcessId($hwnd, [ref]$windowProcessId) | Out-Null
$classBuilder = New-Object System.Text.StringBuilder 256
[ClipboardSyncNative]::GetClassName($hwnd, $classBuilder, $classBuilder.Capacity) | Out-Null
$titleBuilder = New-Object System.Text.StringBuilder 512
[ClipboardSyncNative]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null
$processName = $null
try {
  $processName = (Get-Process -Id $windowProcessId -ErrorAction Stop).ProcessName
} catch {
  $processName = $null
}
$canPaste = $null
$focusedPid = $null
$controlType = $null

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($focused -ne $null) {
    $focusedPid = [int]$focused.Current.ProcessId
    $controlType = [string]$focused.Current.ControlType.ProgrammaticName
    $pattern = $null
    $supportsValue = $focused.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)
    $pattern = $null
    $supportsText = $focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)
    $looksEditable = $controlType -match 'ControlType\\.(Edit|Document|ComboBox)'
    if ($supportsValue -or $supportsText -or $looksEditable) {
      $canPaste = $true
    }
  }
} catch {
  $canPaste = $null
}

@{
  hwnd = $hwnd.ToInt64()
  pid = $windowProcessId
  className = $classBuilder.ToString()
  processName = $processName
  title = $titleBuilder.ToString()
  canPaste = $canPaste
  focusedPid = $focusedPid
  controlType = $controlType
} | ConvertTo-Json -Compress
`;

function pasteScriptForTarget(target) {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ClipboardSyncPasteNative {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
Add-Type -AssemblyName System.Windows.Forms
$hwnd = [IntPtr]${Math.trunc(target.hwnd)}
[ClipboardSyncPasteNative]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 140
[System.Windows.Forms.SendKeys]::SendWait('^v')
`;
}

const macForegroundTargetScript = `
const se = Application('System Events');
const procs = se.applicationProcesses.whose({ frontmost: true })();
if (!procs.length) {
  JSON.stringify(null);
} else {
  const proc = procs[0];
  const bundleId = proc.bundleIdentifier();
  const name = proc.name();
  const focusProbeSkippedBundleIds = new Set(['com.apple.Notes']);
  let role = '';
  let subrole = '';
  let roleDescription = '';
  let canPaste = null;
  let focusState = 'unavailable';
  if (focusProbeSkippedBundleIds.has(bundleId)) {
    focusState = 'focus-probe-skipped';
  } else {
    try {
      const focused = proc.attributes.byName('AXFocusedUIElement').value();
      if (focused) {
        focusState = 'focused-element';
        role = String(focused.attributes.byName('AXRole').value() || '');
        try {
          subrole = String(focused.attributes.byName('AXSubrole').value() || '');
        } catch (error) {}
        try {
          roleDescription = String(focused.attributes.byName('AXRoleDescription').value() || '');
        } catch (error) {}
        canPaste = [
          role,
          subrole,
          roleDescription
        ].some((value) => /text|edit|input|search|combo/i.test(value));
      } else {
        focusState = 'missing-focused-element';
      }
    } catch (error) {}
  }
  JSON.stringify({
    platform: 'darwin',
    pid: proc.unixId(),
    bundleId,
    name,
    role,
    subrole,
    roleDescription,
    focusState,
    canPaste
  });
}
`;

function macPasteScriptForTarget(target) {
  return `
const bundleId = ${JSON.stringify(target.bundleId)};
Application(bundleId).activate();
delay(0.12);
Application('System Events').keystroke('v', { using: ['command down'] });
`;
}

function macPasteHelperPath() {
  if (process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER) {
    return process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER;
  }
  if (process.resourcesPath) {
    const helper = join(process.resourcesPath, 'mac-paste-helper');
    if (existsSync(helper)) {
      return helper;
    }
  }
  return null;
}

function macPasteHelperArgs(target) {
  const args = [target.bundleId];
  if (process.env.CLIPBOARD_SYNC_MAC_PASTE_HELPER_PROMPT !== '0') {
    args.unshift('--prompt');
  }
  return args;
}

function execFileAsync(execFileImpl, file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout ?? '');
        error.stderr = String(stderr ?? '');
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function powershellArgs(script) {
  return ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

function osascriptArgs(script) {
  return ['-l', 'JavaScript', '-e', script];
}

export function parseWindowsForegroundTarget(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    const hwnd = Number(parsed.hwnd);
    const pid = Number(parsed.pid);
    if (!Number.isFinite(hwnd) || !Number.isFinite(pid)) {
      return null;
    }
    return {
      hwnd,
      pid,
      className: typeof parsed.className === 'string' ? parsed.className : '',
      processName: typeof parsed.processName === 'string' ? parsed.processName : '',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      canPaste: typeof parsed.canPaste === 'boolean' ? parsed.canPaste : undefined
    };
  } catch {
    return null;
  }
}

export function parseMacForegroundTarget(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const pid = Number(parsed.pid);
    if (!Number.isFinite(pid) || pid <= 0 || typeof parsed.bundleId !== 'string' || !parsed.bundleId) {
      return null;
    }
    return {
      platform: 'darwin',
      pid,
      bundleId: parsed.bundleId,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      role: typeof parsed.role === 'string' ? parsed.role : '',
      subrole: typeof parsed.subrole === 'string' ? parsed.subrole : '',
      roleDescription: typeof parsed.roleDescription === 'string' ? parsed.roleDescription : '',
      focusState: typeof parsed.focusState === 'string' ? parsed.focusState : '',
      canPaste: typeof parsed.canPaste === 'boolean' ? parsed.canPaste : undefined
    };
  } catch {
    return null;
  }
}

export function isUsablePasteTarget(target, ownPid = process.pid) {
  if (!target) {
    return false;
  }
  if (target.platform === 'darwin' || target.bundleId) {
    if (!Number.isFinite(target.pid) || target.pid <= 0 || target.pid === ownPid) {
      return false;
    }
    if (typeof target.bundleId !== 'string' || !target.bundleId) {
      return false;
    }
    return target.canPaste !== false;
  }
  if (!Number.isFinite(target.hwnd) || target.hwnd <= 0 || !Number.isFinite(target.pid) || target.pid <= 0) {
    return false;
  }
  if (target.pid === ownPid) {
    return false;
  }
  return target.canPaste !== false;
}

export function isRecentPasteTarget(target, { now = Date.now, ttlMs = PASTE_TARGET_TTL_MS } = {}) {
  return Boolean(target?.capturedAt && now() - target.capturedAt <= ttlMs);
}

export async function readWindowsForegroundTarget({ execFileImpl = execFile } = {}) {
  const { stdout } = await execFileAsync(execFileImpl, 'powershell.exe', powershellArgs(foregroundTargetScript), {
    windowsHide: true,
    timeout: 4_000
  });
  return parseWindowsForegroundTarget(stdout);
}

export async function readMacForegroundTarget({ execFileImpl = execFile } = {}) {
  const helper = macPasteHelperPath();
  if (helper) {
    try {
      const { stdout } = await execFileAsync(execFileImpl, helper, ['--frontmost'], { timeout: 1_000 });
      const frontmostTarget = parseMacForegroundTarget(stdout);
      if (frontmostTarget) {
        return frontmostTarget;
      }
    } catch {
      // Fall back to System Events below.
    }
  }

  const { stdout } = await execFileAsync(execFileImpl, '/usr/bin/osascript', osascriptArgs(macForegroundTargetScript), {
    timeout: 4_000
  });
  return parseMacForegroundTarget(stdout);
}

export async function pasteIntoWindowsTarget(target, { execFileImpl = execFile, ownPid = process.pid, onError = () => {} } = {}) {
  if (!isUsablePasteTarget(target, ownPid)) {
    return false;
  }
  try {
    await execFileAsync(execFileImpl, 'powershell.exe', powershellArgs(pasteScriptForTarget(target)), {
      windowsHide: true,
      timeout: 4_000
    });
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

export async function pasteIntoMacTarget(target, { execFileImpl = execFile, ownPid = process.pid, onError = () => {} } = {}) {
  if (!isUsablePasteTarget(target, ownPid)) {
    return false;
  }
  try {
    const helper = macPasteHelperPath();
    if (helper) {
      await execFileAsync(execFileImpl, helper, macPasteHelperArgs(target), { timeout: 12_000 });
    } else {
      await execFileAsync(execFileImpl, '/usr/bin/osascript', osascriptArgs(macPasteScriptForTarget(target)), {
        timeout: 4_000
      });
    }
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
