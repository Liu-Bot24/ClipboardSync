param(
  [string]$ZipPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist\ClipboardSync-windows-x64.zip"),
  [string]$PackageDir = "",
  [string]$ResultPath = (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) "tmp") "windows-smoke-result.json"),
  [switch]$Cleanup,
  [switch]$SkipClipboardRoundTrip,
  [switch]$RestoreClipboard,
  [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"
$AllowedSmokeHubHosts = @("127.0.0.1", "localhost", "::1", "[::1]")
if (-not [string]::IsNullOrWhiteSpace($env:CLIPBOARD_SYNC_ALLOWED_SMOKE_HUB_HOSTS)) {
  $AllowedSmokeHubHosts += @($env:CLIPBOARD_SYNC_ALLOWED_SMOKE_HUB_HOSTS -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

if ($RestoreClipboard -and -not $Cleanup) {
  throw "RestoreClipboard requires -Cleanup so the tested client is stopped before the original clipboard is restored"
}

function Assert-Exists([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing expected path: $Path"
  }
}

function Get-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Get-OptionalFullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $null
  }
  return Get-FullPath $Path
}

function Resolve-ResultPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return Get-FullPath $Path
  }
  return Get-FullPath (Join-Path (Get-Location) $Path)
}

function Get-RunExecutablePath([string]$Value) {
  $Trimmed = $Value.Trim()
  if ($Trimmed.StartsWith('"')) {
    $EndQuote = $Trimmed.IndexOf('"', 1)
    if ($EndQuote -gt 1) {
      return $Trimmed.Substring(1, $EndQuote - 1)
    }
  }
  return ($Trimmed -split '\s+', 2)[0]
}

function Get-RunProperties() {
  $Item = Get-ItemProperty -Path $RunKey -ErrorAction SilentlyContinue
  if (-not $Item) {
    return @()
  }
  return @($Item.PSObject.Properties | Where-Object { $_.MemberType -eq "NoteProperty" })
}

function Read-RunEntryMap() {
  $Entries = @{}
  foreach ($Property in Get-RunProperties) {
    $Entries[$Property.Name] = [string]$Property.Value
  }
  return $Entries
}

function Find-StartupMatches([string]$ExpectedExe) {
  return @(Get-RunProperties | Where-Object {
    try {
      (Get-FullPath (Get-RunExecutablePath ([string]$_.Value))) -ieq $ExpectedExe
    } catch {
      $false
    }
  })
}

function Wait-ForSmokeCondition([string]$Description, [scriptblock]$Condition) {
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $Deadline) {
    $Result = & $Condition
    if ($Result) {
      return $Result
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for $Description"
}

function Require-ClipboardAccess() {
  if ([System.Threading.Thread]::CurrentThread.GetApartmentState().ToString() -ne "STA") {
    throw "Windows clipboard smoke requires powershell.exe -STA"
  }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
}

function Save-ClipboardState() {
  Require-ClipboardAccess
  if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    return @{ kind = "image"; value = [System.Windows.Forms.Clipboard]::GetImage() }
  }
  if ([System.Windows.Forms.Clipboard]::ContainsText()) {
    return @{ kind = "text"; value = [System.Windows.Forms.Clipboard]::GetText() }
  }
  return @{ kind = "empty"; value = $null }
}

function Restore-ClipboardState([hashtable]$State) {
  if (-not $RestoreClipboard -or -not $State) {
    return
  }
  Require-ClipboardAccess
  [System.Windows.Forms.Clipboard]::Clear()
  if ($State.kind -eq "text") {
    [System.Windows.Forms.Clipboard]::SetText([string]$State.value)
  } elseif ($State.kind -eq "image" -and $State.value) {
    [System.Windows.Forms.Clipboard]::SetImage($State.value)
  }
  $script:ClipboardRestored = $true
}

function Set-ClipboardImageFromScreenCapture() {
  Require-ClipboardAccess
  $Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $Width = [Math]::Max(1, [Math]::Min(96, $Bounds.Width))
  $Height = [Math]::Max(1, [Math]::Min(96, $Bounds.Height))
  $Bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
  $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
  try {
    $Graphics.CopyFromScreen($Bounds.Left, $Bounds.Top, 0, 0, $Bitmap.Size)
    [System.Windows.Forms.Clipboard]::SetImage($Bitmap)
  } finally {
    $Graphics.Dispose()
  }
}

function Clipboard-ContainsImage() {
  Require-ClipboardAccess
  return [System.Windows.Forms.Clipboard]::ContainsImage()
}

function Get-Sha256Hex([byte[]]$Bytes) {
  $Sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return -join ($Sha256.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $Sha256.Dispose()
  }
}

function Invoke-HubGet([string]$Path) {
  $Args = @{
    Method = "Get"
    Uri = "$HubUrl$Path"
    TimeoutSec = $TimeoutSeconds
  }
  if (-not [string]::IsNullOrWhiteSpace($HubToken)) {
    $Args.Headers = @{ Authorization = "Bearer $HubToken" }
  }
  return Invoke-RestMethod @Args
}

function Assert-AllowedSmokeHub([string]$Url) {
  $TrimmedUrl = $Url.TrimEnd("/")
  $Uri = [Uri]$TrimmedUrl
  if (-not ($AllowedSmokeHubHosts -contains $Uri.Host)) {
    throw "Refusing to smoke test against unexpected Hub host: $($Uri.Host)"
  }
  return $TrimmedUrl
}

function ConvertTo-WebSocketUrl([string]$Url) {
  if ($Url.StartsWith("https://")) {
    return "wss://" + $Url.Substring(8)
  }
  if ($Url.StartsWith("http://")) {
    return "ws://" + $Url.Substring(7)
  }
  throw "Unsupported Hub URL for WebSocket smoke: $Url"
}

function Send-HubClipboardEvent([string]$PeerId, [string]$TargetDeviceId, [string]$ContentType, [string]$Encoding, [string]$Content) {
  $Ws = [System.Net.WebSockets.ClientWebSocket]::new()
  if (-not [string]::IsNullOrWhiteSpace($HubToken)) {
    $Ws.Options.SetRequestHeader("Authorization", "Bearer $HubToken")
  }
  $WsUrl = ConvertTo-WebSocketUrl $HubUrl
  $Uri = [Uri]"$WsUrl/v1/ws?deviceId=$PeerId&deviceName=WindowsSmoke"
  $ConnectCts = [System.Threading.CancellationTokenSource]::new()
  $ConnectCts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
  $SendCts = $null
  try {
    $Ws.ConnectAsync($Uri, $ConnectCts.Token).GetAwaiter().GetResult()
    $Payload = @{
      type = "clipboard.update"
      contentType = $ContentType
      encoding = $Encoding
      content = $Content
      targetDeviceIds = @($TargetDeviceId)
    } | ConvertTo-Json -Compress
    $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Payload)
    $Segment = [ArraySegment[byte]]::new($Bytes)
    $SendCts = [System.Threading.CancellationTokenSource]::new()
    $SendCts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
    $Ws.SendAsync($Segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $SendCts.Token).GetAwaiter().GetResult()
    Start-Sleep -Milliseconds 700
  } finally {
    $ConnectCts.Dispose()
    if ($SendCts) {
      $SendCts.Dispose()
    }
    if ($Ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $CloseCts = [System.Threading.CancellationTokenSource]::new()
      $CloseCts.CancelAfter([TimeSpan]::FromSeconds(2))
      try {
        $Ws.CloseOutputAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "done", $CloseCts.Token).GetAwaiter().GetResult()
      } finally {
        $CloseCts.Dispose()
      }
    }
    $Ws.Dispose()
  }
}

function Wait-ForHistoryEvent([string]$Description, [scriptblock]$Predicate) {
  return Wait-ForSmokeCondition $Description {
    $History = Invoke-HubGet "/v1/history?deviceId=windows-smoke-observer&limit=50"
    foreach ($Event in @($History.events)) {
      if (& $Predicate $Event) {
        return $Event
      }
    }
    return $null
  }
}

function Get-SmokeClientDevice() {
  return Wait-ForSmokeCondition "ClipboardSync client in Hub device list" {
    $After = @((Invoke-HubGet "/v1/devices").devices)
    $NewDevices = @($After | Where-Object { -not $DevicesBeforeInstall.ContainsKey($_.deviceId) })
    if ($NewDevices.Count -gt 0) {
      return @($NewDevices | Sort-Object connectedAt -Descending)[0]
    }
    if ($After.Count -eq 1) {
      return $After[0]
    }
    return $null
  }
}

function Test-ClipboardRoundTrip([string]$TargetDeviceId) {
  if ($SkipClipboardRoundTrip) {
    return
  }
  Require-ClipboardAccess
  $PeerId = "windows-smoke-peer-$([System.Guid]::NewGuid().ToString("N"))"
  $RemoteText = "clipboard-sync-smoke-remote-$([System.Guid]::NewGuid().ToString("N"))"
  Send-HubClipboardEvent $PeerId $TargetDeviceId "text/plain" "utf8" $RemoteText
  Wait-ForSmokeCondition "remote text to appear on Windows clipboard" {
    try { (Get-Clipboard -Raw) -eq $RemoteText } catch { $false }
  } | Out-Null
  $script:TextInboundPassed = $true

  $LocalText = "clipboard-sync-smoke-local-$([System.Guid]::NewGuid().ToString("N"))"
  Set-Clipboard -Value $LocalText
  Wait-ForHistoryEvent "local text to appear in Hub history" {
    param($Event)
    $Event.sourceDeviceId -eq $TargetDeviceId -and $Event.contentType -eq "text/plain" -and $Event.content -eq $LocalText
  } | Out-Null
  $script:TextOutboundPassed = $true

  $RemotePng = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4GBgYEJRIAwAB8XAgICR7MUAAAAAElFTkSuQmCC"
  [System.Windows.Forms.Clipboard]::Clear()
  Send-HubClipboardEvent $PeerId $TargetDeviceId "image/png" "base64" $RemotePng
  Wait-ForSmokeCondition "remote image to appear on Windows clipboard" { Clipboard-ContainsImage } | Out-Null
  $script:ImageInboundPassed = $true

  Set-ClipboardImageFromScreenCapture
  Wait-ForHistoryEvent "local image to appear in Hub history" {
    param($Event)
    if ($Event.sourceDeviceId -ne $TargetDeviceId -or $Event.contentType -ne "image/png" -or $Event.encoding -ne "base64") {
      return $false
    }
    try {
      $Bytes = [Convert]::FromBase64String([string]$Event.content)
      return $Bytes.Length -gt 0 -and $Event.sha256 -eq (Get-Sha256Hex $Bytes)
    } catch {
      return $false
    }
  } | Out-Null
  $script:ImageOutboundPassed = $true
}

function Invoke-SmokeCleanup() {
  if (-not $Cleanup -or $CleanupPerformed -or [string]::IsNullOrWhiteSpace($ExpectedExe)) {
    return
  }

  $Processes = @(Get-Process -Name "ClipboardSync" -ErrorAction SilentlyContinue |
    Where-Object {
      try { (Get-FullPath $_.Path) -ieq $ExpectedExe } catch { $false }
    })
  foreach ($TargetProcess in $Processes) {
    Stop-Process -Id $TargetProcess.Id -Force -ErrorAction SilentlyContinue
    $script:ProcessStoppedByCleanup = $true
  }

  $script:CleanupPerformed = $true
}

function Remove-SmokeUserData() {
  if (-not $Cleanup -or [string]::IsNullOrWhiteSpace($UserDataPath) -or -not (Test-Path -LiteralPath $UserDataPath)) {
    return
  }

  Remove-Item -LiteralPath $UserDataPath -Recurse -Force -ErrorAction SilentlyContinue
  $script:SmokeUserDataRemoved = -not (Test-Path -LiteralPath $UserDataPath)
}

function Write-SmokeResult([string]$Status, [string]$FailureMessage = "") {
  [ordered]@{
    status = $Status
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    failureStage = $FailureStage
    failureMessage = $FailureMessage
    cleanupError = $CleanupError
    zipPath = Get-OptionalFullPath $ZipPath
    packageDir = Get-OptionalFullPath $PackageDir
    installedPath = Get-OptionalFullPath $InstallDir
    executablePath = Get-OptionalFullPath $ExpectedExe
    processId = $ProcessId
    processPath = Get-OptionalFullPath $ProcessPath
    userDataPath = Get-OptionalFullPath $UserDataPath
    readyMarkerPath = Get-OptionalFullPath $ReadyPath
    readyMarkerStatus = if ($ReadyMarker) { [string]$ReadyMarker.status } else { $null }
    startupPath = Get-OptionalFullPath $StartupPath
    cleanupRequested = [bool]$Cleanup
    cleanupPerformed = $CleanupPerformed
    clipboardRestored = $ClipboardRestored
    smokeUserDataRemoved = $SmokeUserDataRemoved
    textOutboundPassed = $TextOutboundPassed
    textInboundPassed = $TextInboundPassed
    imageOutboundPassed = $ImageOutboundPassed
    imageInboundPassed = $ImageInboundPassed
    processStoppedByCleanup = $ProcessStoppedByCleanup
    startupEntriesRemoved = $StartupEntriesRemoved
    startupEntriesRestored = $StartupEntriesRestored
    startupEntriesPreserved = $StartupEntriesPreserved
    installedFolderRemoved = $InstalledFolderRemoved
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}

$FailureStage = "initializing"
$CleanupError = $null
$ReadyMarker = $null
$StartupPath = $null
$ExpectedExe = $null
$ProcessId = $null
$ProcessPath = $null
$InstallDir = $null
$UserDataPath = $null
$HubUrl = $null
$HubToken = $null
$SavedClipboard = $null
$ClipboardRestored = $false
$SmokeUserDataRemoved = $false
$TextOutboundPassed = $false
$TextInboundPassed = $false
$ImageOutboundPassed = $false
$ImageInboundPassed = $false
$DevicesBeforeInstall = @{}
$CleanupPerformed = $false
$ProcessStoppedByCleanup = $false
$StartupEntriesRemoved = 0
$StartupEntriesRestored = 0
$StartupEntriesPreserved = 0
$InstalledFolderRemoved = $false

if ([string]::IsNullOrWhiteSpace($PackageDir) -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot "ClipboardSync.exe"))) {
  $PackageDir = $PSScriptRoot
}
$UseExistingPackageDir = -not [string]::IsNullOrWhiteSpace($PackageDir)
if ($UseExistingPackageDir) {
  $PackageDir = Get-FullPath $PackageDir
  Assert-Exists $PackageDir
} else {
  Assert-Exists $ZipPath
}
$ResultPath = Resolve-ResultPath $ResultPath
$ResultDir = Split-Path -Parent $ResultPath
New-Item -ItemType Directory -Path $ResultDir -Force | Out-Null
$ReadyPath = Join-Path $ResultDir "windows-smoke-ready.json"
$UserDataPath = Join-Path $ResultDir "windows-smoke-user-data"
Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue

$Scratch = $null
if (-not $UseExistingPackageDir) {
  $Scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("clipboard-sync-smoke-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $Scratch -Force | Out-Null
}
try {
  $FailureStage = "extract"
  if (-not $UseExistingPackageDir) {
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $Scratch -Force
    $PackageDir = Join-Path $Scratch "ClipboardSync-win32-x64"
  }
  Assert-Exists $PackageDir
  $PackageConfig = Get-Content -LiteralPath (Join-Path $PackageDir "clipboard-sync.config.json") -Raw | ConvertFrom-Json
  $HubUrl = Assert-AllowedSmokeHub ([string]$PackageConfig.hubUrl)
  $HubToken = [string]$PackageConfig.token
  if ([string]::IsNullOrWhiteSpace($HubUrl)) {
    throw "Packaged Windows config is missing Hub URL"
  }
  $BeforeDevices = @((Invoke-HubGet "/v1/devices").devices)
  foreach ($Device in $BeforeDevices) {
    $DeviceId = [string]$Device.deviceId
    $DevicesBeforeInstall[$DeviceId] = $true
  }

  $FailureStage = "portable-files"
  $InstallDir = $PackageDir
  $Exe = Join-Path $InstallDir "ClipboardSync.exe"
  $ExpectedExe = Get-FullPath $Exe
  Assert-Exists $Exe
  $RequiredPaths = @(
    "ClipboardSync.exe",
    "resources\app.asar",
    "clipboard-sync.config.json",
    "resources.pak",
    "icudtl.dat",
    "ffmpeg.dll",
    "libEGL.dll",
    "libGLESv2.dll",
    "snapshot_blob.bin",
    "v8_context_snapshot.bin",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "d3dcompiler_47.dll",
    "dxcompiler.dll",
    "dxil.dll",
    "vulkan-1.dll",
    "vk_swiftshader.dll",
    "vk_swiftshader_icd.json",
    "locales\en-US.pak",
    "locales\zh-CN.pak"
  )

  foreach ($RelativePath in $RequiredPaths) {
    Assert-Exists (Join-Path $InstallDir $RelativePath)
  }

  $FailureStage = "portable-launch"
  $PreviousNoPause = $env:CLIPBOARD_SYNC_INSTALL_NO_PAUSE
  $PreviousReadyFile = $env:CLIPBOARD_SYNC_READY_FILE
  $PreviousUserDataDir = $env:CLIPBOARD_SYNC_USER_DATA_DIR
  $PreviousTraceFile = $env:CLIPBOARD_SYNC_TRACE_FILE
  try {
    $env:CLIPBOARD_SYNC_INSTALL_NO_PAUSE = "1"
    $env:CLIPBOARD_SYNC_READY_FILE = $ReadyPath
    $env:CLIPBOARD_SYNC_USER_DATA_DIR = $UserDataPath
    $env:CLIPBOARD_SYNC_TRACE_FILE = Join-Path $ResultDir "windows-smoke-trace.jsonl"
    $Process = Start-Process -FilePath $Exe -WorkingDirectory $InstallDir -PassThru
  } finally {
    $env:CLIPBOARD_SYNC_INSTALL_NO_PAUSE = $PreviousNoPause
    $env:CLIPBOARD_SYNC_READY_FILE = $PreviousReadyFile
    $env:CLIPBOARD_SYNC_USER_DATA_DIR = $PreviousUserDataDir
    $env:CLIPBOARD_SYNC_TRACE_FILE = $PreviousTraceFile
  }
  if (-not $Process) {
    throw "ClipboardSync process did not start from $ExpectedExe"
  }
  Start-Sleep -Milliseconds 500
  if ($Process.HasExited) {
    throw "ClipboardSync process exited early from $ExpectedExe"
  }
  $ProcessId = $Process.Id
  $ProcessPath = $ExpectedExe

  $FailureStage = "ready-marker"
  $ReadyDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $ReadyDeadline) {
    if (Test-Path -LiteralPath $ReadyPath) {
      try {
        $ReadyMarker = Get-Content -LiteralPath $ReadyPath -Raw | ConvertFrom-Json
        if ($ReadyMarker.status -eq "ready") {
          break
        }
      } catch {
        $ReadyMarker = $null
      }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ReadyMarker) {
    throw "ClipboardSync did not write ready marker at $ReadyPath"
  }

  $FailureStage = "clipboard-roundtrip"
  if (-not $SkipClipboardRoundTrip) {
    if ($RestoreClipboard) {
      $SavedClipboard = Save-ClipboardState
    }
    $ClientDevice = Get-SmokeClientDevice
    Test-ClipboardRoundTrip ([string]$ClientDevice.deviceId)
  }

  $FailureStage = "cleanup"
  Invoke-SmokeCleanup
  Remove-SmokeUserData
  Restore-ClipboardState $SavedClipboard

  $FailureStage = "passed"
  Write-SmokeResult "passed"

  Write-Host "Windows package smoke passed"
  Write-Host "Package directory: $InstallDir"
  Write-Host "Process id: $ProcessId"
  Write-Host "Ready marker: $ReadyPath"
  Write-Host "Result written: $ResultPath"
} catch {
  $FailureMessage = $_.Exception.Message
  try {
    Invoke-SmokeCleanup
    Remove-SmokeUserData
  } catch {
    $CleanupError = $_.Exception.Message
  }
  try {
    Restore-ClipboardState $SavedClipboard
  } catch {
    if ([string]::IsNullOrWhiteSpace($CleanupError)) {
      $CleanupError = $_.Exception.Message
    }
  }
  Write-SmokeResult "failed" $FailureMessage
  throw
} finally {
  if (-not [string]::IsNullOrWhiteSpace($Scratch)) {
    Remove-Item -LiteralPath $Scratch -Recurse -Force -ErrorAction SilentlyContinue
  }
}
