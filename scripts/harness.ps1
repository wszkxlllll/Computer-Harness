[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('check', 'start', 'daemon', 'stop', 'doctor', 'tui', 'run', 'help')]
  [string] $Command = 'start',

  [ValidateSet('baseline', 'assisted', 'research')]
  [string] $Preset,

  [ValidateSet('glm-5.3-flash', 'qwen3.8-flash')]
  [string] $Model,

  [string] $Goal,
  [switch] $Build
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot '.harness.local.psd1'

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Missing .harness.local.psd1. Copy .harness.local.example.psd1 and fill the machine-local paths."
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

$nodePath = Resolve-LocalPath (Require-Config 'NodePath')
$envFile = Resolve-LocalPath (Require-Config 'EnvFile')
$cuaBinary = Resolve-LocalPath (Require-Config 'CuaBinary')
$cuaSocket = Require-Config 'CuaSocket'
$selectedModel = if ($Model) { $Model } else { Require-Config 'Model' }
$selectedPreset = if ($Preset) { $Preset } elseif ($config['Preset']) { [string] $config['Preset'] } else { 'assisted' }
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
  $previousPath = $env:PATH
  try {
    $env:PATH = "$nodeDir;$previousPath"
    Push-Location $repoRoot
    try {
      & pnpm.cmd run build
      if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }
    } finally {
      Pop-Location
    }
  } finally {
    $env:PATH = $previousPath
  }
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
    return @('--qwen-coordinate-mode', 'normalized_1000', '--qwen-thinking', 'low', '--qwen-output-mode', 'strict_json')
  }
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
  Write-Output "CLI build  : $distReady ($cliPath)"
  Write-Output "Model      : $selectedModel"
  Write-Output "Preset     : $selectedPreset"
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

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outputDir = Join-Path $outputRoot "$($Command)-$timestamp"
$arguments = @(
  $cliPath,
  '--model', $selectedModel,
  '--computer', 'cua',
  '--cua-socket', $cuaSocket,
  '--env-file', $envFile,
  '--output', $outputDir
)
$arguments += Get-ModelArguments
$arguments += Get-PresetArguments $selectedPreset

$embeddingEndpoint = [string] $config['MemoryEmbeddingEndpoint']
if (-not [string]::IsNullOrWhiteSpace($embeddingEndpoint)) {
  $arguments += @('--memory-embedding-endpoint', $embeddingEndpoint)
}

if ($Command -eq 'tui') {
  $arguments += '--tui'
  Write-Output "Starting TUI with preset '$selectedPreset'. Press F on the home screen to change the next Run."
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
