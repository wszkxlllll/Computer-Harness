[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('check', 'start', 'daemon', 'stop', 'doctor', 'tui', 'run', 'browser-login', 'help')]
  [string] $Command = 'start',

  [ValidateSet('baseline', 'assisted', 'research')]
  [string] $Preset,

  [ValidateSet('off', 'layered')]
  [string] $RiskGuard,

  [ValidateSet('glm-5.3-flash', 'qwen3.8-flash')]
  [string] $Model,

  [string] $Goal,
  [string] $OutputDir,
  [ValidateRange(1, 1000000)]
  [int] $MaxSteps = 100,
  [ValidateRange(1, 1000000)]
  [int] $MaxModelRequests = 100,
  [string] $ManagedBrowserUrl,
  [ValidateSet('ephemeral', 'persistent')]
  [string] $ManagedBrowserProfileMode,
  [string] $ManagedBrowserProfileLabel,
  [ValidateSet('local', 'jev')]
  [string] $WindowSelector,
  [switch] $ShareWindowTitles,
  [string] $CuaWindowPid,
  [string] $CuaWindowId,
  [ValidateSet('off', 'auto', 'uia-catalog-v1', 'dom-catalog-v1', 'hybrid-catalog-v1')]
  [string] $Grounding,
  [switch] $WindowSwitch,
  [ValidateSet('native_tools', 'strict_json')]
  [string] $QwenOutputMode,
  [switch] $AllowExistingOutputDir,
  [switch] $Build
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot '.harness.local.psd1'

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Missing .harness.local.psd1. From the repository root run 'Copy-Item .harness.local.example.psd1 .harness.local.psd1', then set NodePath, EnvFile, CuaBinary, CuaSocket, Model and OutputRoot in the copy. Keep API keys in the referenced .env file."
}

$config = Import-PowerShellDataFile -LiteralPath $configPath

function Resolve-LocalPath([string] $Value) {
  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Value))
}

function Require-Config([string] $Name) {
  $value = $config[$Name]
  if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string] $value)) {
    throw "Missing '$Name' in .harness.local.psd1."
  }
  return [string] $value
}

function Get-CuaWindowArguments {
  $hasPid = -not [string]::IsNullOrWhiteSpace($CuaWindowPid)
  $hasWindowId = -not [string]::IsNullOrWhiteSpace($CuaWindowId)
  if ($hasPid -ne $hasWindowId) {
    throw '-CuaWindowPid and -CuaWindowId must be provided together.'
  }
  if (-not $hasPid) { return @() }
  foreach ($entry in @(@{ Name = '-CuaWindowPid'; Value = $CuaWindowPid }, @{ Name = '-CuaWindowId'; Value = $CuaWindowId })) {
    if ($entry.Value -notmatch '^[1-9][0-9]*$') { throw "$($entry.Name) must be a positive safe integer." }
    try {
      $number = [decimal]::Parse($entry.Value, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture)
    } catch {
      throw "$($entry.Name) must be a positive safe integer."
    }
    if ($number -gt 9007199254740991) { throw "$($entry.Name) must be a positive safe integer." }
  }
  return @('--cua-window-pid', $CuaWindowPid, '--cua-window-id', $CuaWindowId)
}

$nodePath = Resolve-LocalPath (Require-Config 'NodePath')
$envFile = Resolve-LocalPath (Require-Config 'EnvFile')
$cuaBinary = Resolve-LocalPath (Require-Config 'CuaBinary')
$cuaSocket = Require-Config 'CuaSocket'
$selectedModel = if ($Model) { $Model } else { Require-Config 'Model' }
$selectedPreset = if ($Preset) { $Preset } elseif ($config['Preset']) { [string] $config['Preset'] } else { 'assisted' }
$selectedRiskGuard = if ($RiskGuard) { $RiskGuard } elseif ($selectedPreset -eq 'research') { 'off' } else { 'layered' }
$selectedWindowSelector = if ($WindowSelector) { $WindowSelector } elseif ($config['WindowSelector']) { [string] $config['WindowSelector'] } else { 'local' }
$selectedShareWindowTitles = $ShareWindowTitles -or $config['ShareWindowTitles'] -eq $true
$selectedBrowserMode = if ($ManagedBrowserProfileMode) { $ManagedBrowserProfileMode } else { [string] $config['ManagedBrowserProfileMode'] }
$selectedBrowserLabel = if ($ManagedBrowserProfileLabel) { $ManagedBrowserProfileLabel } else { [string] $config['ManagedBrowserProfileLabel'] }
function Get-ManagedBrowserArguments {
  if ([string]::IsNullOrWhiteSpace($ManagedBrowserUrl)) {
    $profileOnly = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($selectedBrowserMode)) { [void]$profileOnly.Add('--managed-browser-profile-mode'); [void]$profileOnly.Add($selectedBrowserMode) }
    if (-not [string]::IsNullOrWhiteSpace($selectedBrowserLabel)) { [void]$profileOnly.Add('--managed-browser-profile-label'); [void]$profileOnly.Add($selectedBrowserLabel) }
    return $profileOnly.ToArray()
  }
  $parsed = $null
  if (-not [Uri]::TryCreate($ManagedBrowserUrl.Trim(), [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -notin @('http', 'https') -or [string]::IsNullOrWhiteSpace($parsed.Host)) {
    throw 'ManagedBrowserUrl must be an explicit http(s) URL.'
  }
  $result = [System.Collections.Generic.List[string]]::new()
  [void]$result.Add('--managed-browser-url'); [void]$result.Add($ManagedBrowserUrl.Trim())
  if (-not [string]::IsNullOrWhiteSpace($selectedBrowserMode)) { [void]$result.Add('--managed-browser-profile-mode'); [void]$result.Add($selectedBrowserMode) }
  if (-not [string]::IsNullOrWhiteSpace($selectedBrowserLabel)) { [void]$result.Add('--managed-browser-profile-label'); [void]$result.Add($selectedBrowserLabel) }
  return $result.ToArray()
}
$cuaWindowArguments = Get-CuaWindowArguments
$managedBrowserArguments = Get-ManagedBrowserArguments
$outputRoot = Resolve-LocalPath (Require-Config 'OutputRoot')
$cliPath = Join-Path $repoRoot 'apps\cli\dist\index.js'

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Configured Node executable was not found: $nodePath"
}

$nodeVersion = (& $nodePath -p "process.versions.node").Trim()
$nodeMajor = [int] ($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) {
  throw "Computer Harness requires Node >=22.13.0; configured Node is $nodeVersion."
}

function Invoke-Build {
  $nodeDir = Split-Path -Parent $nodePath
  $configuredPnpm = [string] $config['PnpmCliPath']
  if ([string]::IsNullOrWhiteSpace($configuredPnpm)) {
    $fallbackPnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $fallbackPnpm) {
      throw "pnpm was not found. Set PnpmCliPath in .harness.local.psd1 to a local pnpm .mjs/.cjs/.js entry (or an explicit pnpm command)."
    }
    $pnpmPath = $fallbackPnpm.Source
  } else {
    $pnpmPath = Resolve-LocalPath $configuredPnpm
    if (-not (Test-Path -LiteralPath $pnpmPath -PathType Leaf)) {
      throw "Configured PnpmCliPath was not found: $pnpmPath"
    }
    $extension = [System.IO.Path]::GetExtension($pnpmPath).ToLowerInvariant()
    if ($extension -notin @('.mjs', '.cjs', '.js', '.cmd', '.bat', '.exe')) {
      throw "Configured PnpmCliPath must point to .mjs, .cjs, .js, .cmd, .bat, or .exe: $pnpmPath"
    }
  }
  $pnpmExtension = [System.IO.Path]::GetExtension($pnpmPath).ToLowerInvariant()
  $pnpmShimRoot = $null
  $previousNodeExecPath = $env:npm_node_execpath
  $previousExecPath = $env:npm_execpath
  $previousPnpmCliPath = $env:PNPM_CLI_PATH
  $previousBuildNodeExe = $env:HARNESS_BUILD_NODE_EXE
  $previousBuildPnpmCli = $env:HARNESS_BUILD_PNPM_CLI
  $previousPath = $env:PATH
  try {
    $pnpmShimRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("computer-harness-pnpm-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $pnpmShimRoot -ErrorAction Stop | Out-Null
    $pnpmShim = Join-Path $pnpmShimRoot 'pnpm.cmd'
    $shimBody = if ($pnpmExtension -in @('.mjs', '.cjs', '.js')) {
      "@echo off`r`n`"%HARNESS_BUILD_NODE_EXE%`" `"%HARNESS_BUILD_PNPM_CLI%`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    } else {
      "@echo off`r`ncall `"%HARNESS_BUILD_PNPM_CLI%`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    }
    [IO.File]::WriteAllText($pnpmShim, $shimBody, [Text.Encoding]::ASCII)
    $env:PATH = "$pnpmShimRoot;$nodeDir;$previousPath"
    $env:npm_node_execpath = $nodePath
    $env:npm_execpath = $pnpmPath
    $env:PNPM_CLI_PATH = $pnpmPath
    $env:HARNESS_BUILD_NODE_EXE = $nodePath
    $env:HARNESS_BUILD_PNPM_CLI = $pnpmPath
    Push-Location $repoRoot
    try {
      if ($pnpmExtension -in @('.mjs', '.cjs', '.js')) {
        & $nodePath $pnpmPath run build
      } else {
        & $pnpmPath run build
      }
      $buildExitCode = $LASTEXITCODE
      if ($buildExitCode -ne 0) { throw "Build failed with exit code $buildExitCode." }
    } finally {
      Pop-Location
    }
  } finally {
    $env:PATH = $previousPath
    if ($null -eq $previousNodeExecPath) { Remove-Item Env:npm_node_execpath -ErrorAction SilentlyContinue } else { $env:npm_node_execpath = $previousNodeExecPath }
    if ($null -eq $previousExecPath) { Remove-Item Env:npm_execpath -ErrorAction SilentlyContinue } else { $env:npm_execpath = $previousExecPath }
    if ($null -eq $previousPnpmCliPath) { Remove-Item Env:PNPM_CLI_PATH -ErrorAction SilentlyContinue } else { $env:PNPM_CLI_PATH = $previousPnpmCliPath }
    if ($null -eq $previousBuildNodeExe) { Remove-Item Env:HARNESS_BUILD_NODE_EXE -ErrorAction SilentlyContinue } else { $env:HARNESS_BUILD_NODE_EXE = $previousBuildNodeExe }
    if ($null -eq $previousBuildPnpmCli) { Remove-Item Env:HARNESS_BUILD_PNPM_CLI -ErrorAction SilentlyContinue } else { $env:HARNESS_BUILD_PNPM_CLI = $previousBuildPnpmCli }
    if ($null -ne $pnpmShimRoot -and (Test-Path -LiteralPath $pnpmShimRoot)) {
      $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
      $shimRootFull = [IO.Path]::GetFullPath($pnpmShimRoot)
      if (-not $shimRootFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $shimRootFull) -notlike 'computer-harness-pnpm-*') {
        throw "Refusing to remove an unexpected pnpm shim directory: $shimRootFull"
      }
      Remove-Item -LiteralPath $shimRootFull -Recurse -Force
    }
  }
}

if ($AllowExistingOutputDir -and $Command -ne 'tui') {
  throw "-AllowExistingOutputDir is only valid with -Command tui."
}

if ($Build -or -not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  Invoke-Build
}

function Get-PresetArguments([string] $Name) {
  switch ($Name) {
    'baseline' {
      return @('--memory', 'off', '--memory-retrieval', 'off', '--batching', 'off', '--context-mode', 'raw', '--monitor', 'off')
    }
    'assisted' {
      return @('--planning', '--memory', 'facts', '--memory-retrieval', 'lexical', '--batching', 'same-control-input-v1', '--context-mode', 'recent', '--context-max-events', '80', '--monitor', 'shadow')
    }
    'research' {
      return @('--planning', '--memory', 'entities', '--memory-retrieval', 'lexical', '--batching', 'same-control-input-v1', '--context-mode', 'recent', '--context-max-events', '80', '--monitor', 'guidance')
    }
    default { throw "Unknown preset '$Name'." }
  }
}

function Get-ModelArguments {
  if ($selectedModel -eq 'qwen3.8-flash') {
    $outputMode = if ([string]::IsNullOrWhiteSpace($QwenOutputMode)) { 'strict_json' } else { $QwenOutputMode }
    return @('--qwen-coordinate-mode', 'normalized_1000', '--qwen-thinking', 'low', '--qwen-output-mode', $outputMode)
  }
  if (-not [string]::IsNullOrWhiteSpace($QwenOutputMode)) { throw '-QwenOutputMode is only valid with qwen3.8-flash.' }
  return @()
}

function Assert-CuaBinary {
  if (-not (Test-Path -LiteralPath $cuaBinary -PathType Leaf)) {
    throw "CUA daemon executable was not found: $cuaBinary"
  }
}

function Test-CuaReady {
  # Windows PowerShell 5 turns native stderr into an ErrorRecord. With the
  # launcher's strict ErrorActionPreference, the expected "not running"
  # status would otherwise abort before we can start the daemon.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $cuaBinary status --socket $cuaSocket 1>$null 2>$null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Show-Check {
  $envReady = Test-Path -LiteralPath $envFile -PathType Leaf
  $cuaReady = Test-Path -LiteralPath $cuaBinary -PathType Leaf
  $distReady = Test-Path -LiteralPath $cliPath -PathType Leaf
  Write-Output "Repository : $repoRoot"
  Write-Output "Node       : $nodeVersion ($nodePath)"
  Write-Output "Environment: $envReady ($envFile)"
  Write-Output "CUA daemon : $cuaReady ($cuaBinary)"
  Write-Output "CUA socket : $cuaSocket"
  Write-Output "CUA target : $(if ($cuaWindowArguments.Count -eq 0) { 'primary desktop (default)' } else { "window pid=$CuaWindowPid id=$CuaWindowId (host-selected)" })"
  Write-Output "CLI build  : $distReady ($cliPath)"
  Write-Output "Model      : $selectedModel"
  Write-Output "Preset     : $selectedPreset"
  Write-Output "Risk Guard : $selectedRiskGuard"
  Write-Output "Window selection: $selectedWindowSelector; title sharing: $selectedShareWindowTitles"
  Write-Output "Output root: $outputRoot"
  Write-Output "Secrets are loaded from the local env file; no system-wide variables are required."
}

if ($Command -eq 'check') {
  Show-Check
  exit 0
}

if ($Command -eq 'help') {
  & $nodePath $cliPath --help
  exit $LASTEXITCODE
}

Assert-CuaBinary

if ($Command -eq 'daemon') {
  Write-Output "Starting CUA 0.22.2 in this terminal. Keep it open while using the Harness."
  Write-Output "Socket: $cuaSocket"
  & $cuaBinary serve --socket $cuaSocket --no-overlay
  exit $LASTEXITCODE
}

if ($Command -eq 'stop') {
  & $cuaBinary stop --socket $cuaSocket
  exit $LASTEXITCODE
}

if ($Command -eq 'doctor') {
  & $nodePath $cliPath --doctor --computer cua --cua-socket $cuaSocket --doctor-timeout-ms 15000
  exit $LASTEXITCODE
}

if ($Command -eq 'browser-login') {
  if ([string]::IsNullOrWhiteSpace($ManagedBrowserUrl)) { throw "-Command browser-login requires -ManagedBrowserUrl <http(s)-url>." }
  if ($selectedBrowserMode -ne 'persistent' -or [string]::IsNullOrWhiteSpace($selectedBrowserLabel)) {
    throw "-Command browser-login requires -ManagedBrowserProfileMode persistent and -ManagedBrowserProfileLabel <label>."
  }
  if (-not (Test-CuaReady)) { throw 'CUA daemon is not ready; start it explicitly before browser-login.' }
  $prepareArguments = @(
    $cliPath,
    '--prepare-managed-browser-profile',
    '--computer', 'cua',
    '--cua-socket', $cuaSocket
  )
  $prepareArguments += $managedBrowserArguments
  & $nodePath @prepareArguments
  exit $LASTEXITCODE
}

$ownedDaemon = $false
$daemonProcess = $null
if ($Command -eq 'start') {
  if (-not (Test-CuaReady)) {
    Write-Output "Starting the local CUA daemon in the background..."
    $daemonProcess = Start-Process -FilePath $cuaBinary -ArgumentList @('serve', '--socket', $cuaSocket, '--no-overlay') -WindowStyle Hidden -PassThru
    $ownedDaemon = $true
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
      Start-Sleep -Milliseconds 500
      if (Test-CuaReady) {
        $ready = $true
        break
      }
      if ($daemonProcess.HasExited) { break }
    }
    if (-not $ready) {
      if (-not $daemonProcess.HasExited) { $daemonProcess.Kill() }
      throw "CUA daemon did not become ready within 10 seconds. Run '.\scripts\harness.ps1 daemon' to inspect its output."
    }
  } else {
    Write-Output "Reusing the CUA daemon already running on $cuaSocket."
  }
  $Command = 'tui'
}

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
  throw "Local env file was not found: $envFile"
}

if ($OutputDir) {
  $outputDir = Resolve-LocalPath $OutputDir
  if (Test-Path -LiteralPath $outputDir -PathType Leaf) {
    throw "Configured output directory is a file: $outputDir"
  }
  if (-not $AllowExistingOutputDir -and (Test-Path -LiteralPath $outputDir -PathType Container) -and ($null -ne (Get-ChildItem -LiteralPath $outputDir -Force | Select-Object -First 1))) {
    throw "Configured output directory must be empty: $outputDir"
  }
  if (-not (Test-Path -LiteralPath $outputDir)) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
  }
} else {
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $outputDir = Join-Path $outputRoot "$($Command)-$timestamp"
}
$arguments = @(
  $cliPath,
  '--model', $selectedModel,
  '--computer', 'cua',
  '--cua-socket', $cuaSocket,
  '--env-file', $envFile,
  '--output', $outputDir,
  '--max-steps', [string]$MaxSteps,
  '--max-model-requests', [string]$MaxModelRequests,
  '--profile', 'live-interactive',
  '--risk-guard', $selectedRiskGuard
)
if ($selectedRiskGuard -eq 'off') { $arguments += '--confirm-risk-guard-off' }
if (-not [string]::IsNullOrWhiteSpace($Grounding)) { $arguments += @('--grounding', $Grounding) }
if ($WindowSwitch) { $arguments += '--window-switch' }
if ($selectedWindowSelector -eq 'jev' -and $Command -eq 'tui') {
  if (-not $selectedShareWindowTitles) { throw 'Jev window selection requires explicit -ShareWindowTitles or local ShareWindowTitles = $true.' }
  $arguments += @('--window-selection', 'jev', '--allow-window-title-sharing')
}
$arguments += Get-ModelArguments
$arguments += Get-PresetArguments $selectedPreset
$arguments += $cuaWindowArguments
$arguments += $managedBrowserArguments

$embeddingEndpoint = [string] $config['MemoryEmbeddingEndpoint']
if (-not [string]::IsNullOrWhiteSpace($embeddingEndpoint)) {
  $arguments += @('--memory-embedding-endpoint', $embeddingEndpoint)
}

if ($Command -eq 'tui') {
  $arguments += '--tui'
  $guardState = if ($selectedRiskGuard -eq 'layered') { 'ON (layered)' } else { 'OFF (explicit)' }
  Write-Output "TUI setup: model '$selectedModel', preset '$selectedPreset', Risk Guard $guardState."
  Write-Output "Home: enter a goal and press Enter; D or PageDown opens details (Esc returns); F reviews advanced options. To choose a CUA window, press Esc then W."
  $tuiExit = 1
  try {
    & $nodePath @arguments
    $tuiExit = $LASTEXITCODE
  } finally {
    if ($ownedDaemon) {
      Write-Output "Stopping the CUA daemon started by this launcher..."
      & $cuaBinary stop --socket $cuaSocket *> $null
      if ($null -ne $daemonProcess -and -not $daemonProcess.HasExited) {
        $daemonProcess.WaitForExit(5000) | Out-Null
      }
    }
  }
  exit $tuiExit
}

if ([string]::IsNullOrWhiteSpace($Goal)) {
  throw "The 'run' command requires -Goal '<approved goal>'."
}
$arguments += @('--interactive', '--goal', $Goal)
& $nodePath @arguments
exit $LASTEXITCODE
