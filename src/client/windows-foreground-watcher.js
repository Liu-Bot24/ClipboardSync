import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

import { parseWindowsClipboardSource } from './clipboard-source.js';
import { parseWindowsForegroundTarget } from './direct-paste.js';

// One long-lived PowerShell compiles its helpers once, instead of a new
// PowerShell (and C# compile) for every sample. It samples periodically, and
// immediately when Node writes a request id to stdin; each line echoes the
// highest id read so far, so a reply is never older than its request. It
// exits on stdin EOF, which also happens when the app dies.
export function windowsWatcherScript(intervalMs) {
  return `
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ClipboardSyncWatchNative {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern IntPtr GetClipboardOwner();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@
$automationAvailable = $true
try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes } catch { $automationAvailable = $false }

function Read-Window([IntPtr]$hwnd) {
  $processId = 0
  $processName = $null
  $classBuilder = New-Object System.Text.StringBuilder 256
  $titleBuilder = New-Object System.Text.StringBuilder 512
  if ($hwnd -ne [IntPtr]::Zero) {
    [ClipboardSyncWatchNative]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null
    [ClipboardSyncWatchNative]::GetClassName($hwnd, $classBuilder, $classBuilder.Capacity) | Out-Null
    [ClipboardSyncWatchNative]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null
  }
  if ($processId -gt 0) {
    try {
      $process = [System.Diagnostics.Process]::GetProcessById($processId)
      $processName = $process.ProcessName
      $process.Dispose()
    } catch {
      $processName = $null
    }
  }
  return @{
    hwnd = $hwnd.ToInt64()
    pid = $processId
    className = $classBuilder.ToString()
    processName = $processName
    title = $titleBuilder.ToString()
  }
}

function Read-Focus {
  $result = @{ canPaste = $null; focusedPid = $null; controlType = $null }
  if (-not $automationAvailable) { return $result }
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused -ne $null) {
      $result.focusedPid = [int]$focused.Current.ProcessId
      $result.controlType = [string]$focused.Current.ControlType.ProgrammaticName
      $pattern = $null
      $supportsValue = $focused.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)
      $pattern = $null
      $supportsText = $focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)
      $looksEditable = $result.controlType -match 'ControlType\\.(Edit|Document|ComboBox)'
      if ($supportsValue -or $supportsText -or $looksEditable) { $result.canPaste = $true }
    }
  } catch {
    $result.canPaste = $null
  }
  return $result
}

$stdin = [Console]::OpenStandardInput()
$buffer = New-Object byte[] 256
$read = $stdin.ReadAsync($buffer, 0, $buffer.Length)
$requestId = 0
while ($true) {
  try { $ready = $read.Wait(${Math.trunc(intervalMs)}) } catch { break }
  if ($ready) {
    $count = $read.Result
    if ($count -le 0) { break }
    foreach ($token in ([System.Text.Encoding]::ASCII.GetString($buffer, 0, $count) -split '\\s+')) {
      $value = 0
      if ([int]::TryParse($token, [ref]$value) -and $value -gt $requestId) { $requestId = $value }
    }
    $read = $stdin.ReadAsync($buffer, 0, $buffer.Length)
  }
  $target = Read-Window ([ClipboardSyncWatchNative]::GetForegroundWindow())
  $focus = Read-Focus
  $owner = Read-Window ([ClipboardSyncWatchNative]::GetClipboardOwner())
  $sample = @{
    requestId = $requestId
    target = @{
      hwnd = $target.hwnd
      pid = $target.pid
      className = $target.className
      processName = $target.processName
      title = $target.title
      canPaste = $focus.canPaste
      focusedPid = $focus.focusedPid
      controlType = $focus.controlType
    }
    source = @{
      platform = 'win32'
      ownerHwnd = $owner.hwnd
      ownerPid = $owner.pid
      processName = $owner.processName
      title = $owner.title
    }
  }
  [Console]::Out.WriteLine(($sample | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
`;
}

export function parseWatcherLine(line) {
  try {
    const parsed = JSON.parse(String(line || '').replace(/^﻿/, '').trim());
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      requestId: Number.isSafeInteger(parsed.requestId) ? parsed.requestId : 0,
      target: parseWindowsForegroundTarget(JSON.stringify(parsed.target ?? null)),
      source: parseWindowsClipboardSource(JSON.stringify(parsed.source ?? null))
    };
  } catch {
    return null;
  }
}

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export class WindowsForegroundWatcher extends EventEmitter {
  constructor({
    spawnImpl = spawn,
    intervalMs = 1_000,
    requestTimeoutMs = 1_500,
    stallMs = 15_000,
    restartBaseMs = 1_000,
    restartMaxMs = 30_000,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval
  } = {}) {
    super();
    this.spawnImpl = spawnImpl;
    this.intervalMs = intervalMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stallMs = stallMs;
    this.restartBaseMs = restartBaseMs;
    this.restartMaxMs = restartMaxMs;
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.child = null;
    this.stopped = true;
    this.nextRequestId = 0;
    this.pending = new Set();
    this.restartTimer = null;
    this.restartAttempt = 0;
    this.stallTimer = null;
    this.startedAt = 0;
    this.lastLineAt = 0;
  }

  isRunning() {
    return Boolean(this.child && this.child.exitCode === null);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.spawnChild();
    this.stallTimer = this.setIntervalImpl(() => this.checkStall(), Math.max(1_000, Math.floor(this.stallMs / 3)));
    this.stallTimer?.unref?.();
  }

  stop() {
    this.stopped = true;
    this.clearTimeoutImpl(this.restartTimer);
    this.restartTimer = null;
    this.clearIntervalImpl(this.stallTimer);
    this.stallTimer = null;
    this.resolvePending(() => true, null);
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.stdin?.end?.();
      child.kill?.();
    }
  }

  spawnChild() {
    let child;
    try {
      child = this.spawnImpl('powershell.exe', [
        '-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodedCommand(windowsWatcherScript(this.intervalMs))
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) {
      this.emit('error', error);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.startedAt = this.now();
    this.lastLineAt = this.startedAt;
    child.stdin?.on?.('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child) return;
      const sample = parseWatcherLine(line);
      if (!sample) return;
      this.lastLineAt = this.now();
      if (this.now() - this.startedAt >= 60_000) this.restartAttempt = 0;
      this.emit('sample', sample);
      this.resolvePending((request) => request.id <= sample.requestId, sample);
    });
    const onGone = () => {
      if (this.child !== child) return;
      this.child = null;
      lines.close();
      this.resolvePending(() => true, null);
      this.scheduleRestart();
    };
    child.once('exit', onGone);
    child.once('error', (error) => {
      this.emit('error', error);
      onGone();
    });
  }

  scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    const delay = Math.min(this.restartMaxMs, this.restartBaseMs * 2 ** Math.min(this.restartAttempt++, 10));
    this.restartTimer = this.setTimeoutImpl(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.child) this.spawnChild();
    }, delay);
    this.restartTimer?.unref?.();
  }

  checkStall() {
    // A hung UI Automation call stalls the loop; replace the process.
    if (this.isRunning() && this.now() - this.lastLineAt > this.stallMs) this.child.kill?.();
  }

  // Resolves with a sample taken after this call, or null when none arrives in time.
  request() {
    if (!this.isRunning()) return Promise.resolve(null);
    const id = ++this.nextRequestId;
    return new Promise((resolve) => {
      const request = { id, resolve };
      request.timer = this.setTimeoutImpl(() => {
        this.pending.delete(request);
        resolve(null);
      }, this.requestTimeoutMs);
      this.pending.add(request);
      try {
        this.child.stdin.write(`${id}\n`);
      } catch {
        this.resolvePending((item) => item === request, null);
      }
    });
  }

  resolvePending(matches, value) {
    for (const request of [...this.pending]) {
      if (!matches(request)) continue;
      this.pending.delete(request);
      this.clearTimeoutImpl(request.timer);
      request.resolve(value);
    }
  }
}
