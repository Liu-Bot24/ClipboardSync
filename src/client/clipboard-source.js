import { execFile } from 'node:child_process';

const windowsClipboardSourceScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ClipboardSyncSourceNative {
  [DllImport("user32.dll")]
  public static extern IntPtr GetClipboardOwner();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
}
"@

function Read-WindowInfo($hwnd) {
  $processId = 0
  if ($hwnd -ne [IntPtr]::Zero) {
    [ClipboardSyncSourceNative]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null
  }
  $processName = $null
  try {
    if ($processId -gt 0) {
      $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
    }
  } catch {
    $processName = $null
  }
  $titleBuilder = New-Object System.Text.StringBuilder 512
  if ($hwnd -ne [IntPtr]::Zero) {
    [ClipboardSyncSourceNative]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null
  }
  return @{
    hwnd = $hwnd.ToInt64()
    pid = $processId
    processName = $processName
    title = $titleBuilder.ToString()
  }
}

$owner = Read-WindowInfo ([ClipboardSyncSourceNative]::GetClipboardOwner())
@{
  platform = "win32"
  ownerHwnd = $owner.hwnd
  ownerPid = $owner.pid
  processName = $owner.processName
  title = $owner.title
} | ConvertTo-Json -Compress
`;

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

export function parseWindowsClipboardSource(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return {
      platform: 'win32',
      ownerHwnd: Number(parsed.ownerHwnd) || 0,
      ownerPid: Number(parsed.ownerPid) || 0,
      processName: typeof parsed.processName === 'string' ? parsed.processName : '',
      title: typeof parsed.title === 'string' ? parsed.title : ''
    };
  } catch {
    return null;
  }
}

export async function readWindowsClipboardSource({ execFileImpl = execFile } = {}) {
  const { stdout } = await execFileAsync(execFileImpl, 'powershell.exe', powershellArgs(windowsClipboardSourceScript));
  return parseWindowsClipboardSource(stdout);
}

export async function readMacClipboardSource() {
  return null;
}

export async function readClipboardSource(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    return readWindowsClipboardSource(options);
  }
  if (platform === 'darwin') {
    return readMacClipboardSource(options);
  }
  return null;
}
