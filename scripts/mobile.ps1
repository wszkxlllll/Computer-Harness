[CmdletBinding()]
param(
  [ValidateSet('check', 'start', 'help')]
  [string] $Command = 'start',
  [ValidateRange(1, 65535)]
  [int] $HostPort = 4317,
  [ValidateRange(1, 65535)]
  [int] $WebPort = 5173,
  [switch] $Dev,
  [switch] $Build
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot '.harness.local.psd1'

if ($Command -eq 'help') {
  Write-Output 'Local mobile-control launcher.'
  Write-Output 'Usage: .\scripts\mobile.ps1 [-Command check|start] [-HostPort 4317] [-Build] [-Dev [-WebPort 5173]]'
  Write-Output 'The default launch serves the built Web console from the loopback Host. -Dev enables the Vite server.'
  Write-Output 'The configured CUA daemon is reused when ready; otherwise it is started hidden and stopped on exit.'
  exit 0
}

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "Missing .harness.local.psd1. Copy .harness.local.example.psd1, then set NodePath, PnpmCliPath, EnvFile, CuaSocket, Model and OutputRoot. Keep API keys in the referenced env file."
}
$config = Import-PowerShellDataFile -LiteralPath $configPath

function Resolve-LocalPath([string] $Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'A configured local path is empty.' }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Value))
}

function Require-Config([string] $Name) {
  $value = $config[$Name]
  if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string] $value)) {
    throw "Missing '$Name' in .harness.local.psd1."
  }
  return [string] $value
}

function ConvertTo-WindowsArgument([string] $Value) {
  $builder = [System.Text.StringBuilder]::new()
  [void] $builder.Append('"')
  $backslashes = 0
  for ($index = 0; $index -lt $Value.Length; $index += 1) {
    $character = $Value[$index]
    if ($character -eq [char]92) {
      $backslashes += 1
      continue
    }
    if ($character -eq [char]34) {
      [void] $builder.Append([string]::new([char]92, ($backslashes * 2) + 1))
      [void] $builder.Append([char]34)
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) { [void] $builder.Append([string]::new([char]92, $backslashes)) }
    [void] $builder.Append($character)
    $backslashes = 0
  }
  if ($backslashes -gt 0) { [void] $builder.Append([string]::new([char]92, $backslashes * 2)) }
  [void] $builder.Append('"')
  return $builder.ToString()
}

function Test-TcpListener([string] $HostName, [int] $Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.ConnectAsync($HostName, $Port)
    if (-not $connect.Wait(250)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Test-CuaReady {
  $previousPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5 can surface native stderr as an ErrorRecord even
    # when a nonzero CUA status is the expected "not running" result.
    $ErrorActionPreference = 'Continue'
    & $cuaBinary status --socket $cuaSocket 1>$null 2>$null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

$nodePath = Resolve-LocalPath (Require-Config 'NodePath')
$envFile = Resolve-LocalPath (Require-Config 'EnvFile')
$cuaBinary = Resolve-LocalPath (Require-Config 'CuaBinary')
$cuaSocket = Require-Config 'CuaSocket'
$model = Require-Config 'Model'
$outputRoot = Resolve-LocalPath (Require-Config 'OutputRoot')
$hostEntry = Join-Path $repoRoot 'apps\host\dist\index.js'
$hostTypecheckProject = Join-Path $repoRoot 'tsconfig.json'
$typescriptEntry = Join-Path $repoRoot 'node_modules\typescript\lib\tsc.js'
$webRoot = Join-Path $repoRoot 'apps\web'
$webIndex = Join-Path $webRoot 'dist\index.html'
$viteEntry = Join-Path $webRoot 'node_modules\vite\bin\vite.js'

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Configured Node executable was not found: $nodePath" }
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw "Local env file was not found: $envFile" }
if ($model -notin @('glm-5.3-flash', 'qwen3.8-flash')) { throw "Unsupported configured Model: $model" }

if ($Dev) {
  $pnpmValue = Require-Config 'PnpmCliPath'
  $pnpmPath = Resolve-LocalPath $pnpmValue
  if (-not (Test-Path -LiteralPath $pnpmPath -PathType Leaf)) { throw "Configured PnpmCliPath was not found: $pnpmPath" }
  if (-not (Test-Path -LiteralPath $viteEntry -PathType Leaf)) { throw "Vite was not found: $viteEntry" }
}

$nodeVersion = (& $nodePath -p 'process.versions.node').Trim()
if ([version] $nodeVersion -lt [version] '22.13.0') { throw "Computer Harness requires Node >=22.13.0; configured Node is $nodeVersion." }

if ($Command -eq 'check') {
  Write-Output "Repository : $repoRoot"
  Write-Output "Node       : $nodeVersion ($nodePath)"
  Write-Output "Environment: $envFile"
  Write-Output "CUA daemon : $cuaBinary"
  Write-Output "CUA socket : $cuaSocket"
  Write-Output "Host       : http://localhost:$HostPort"
  if ($Dev) { Write-Output "Vite dev   : http://localhost:$WebPort" }
  Write-Output "Host build : $(Test-Path -LiteralPath $hostEntry -PathType Leaf)"
  Write-Output "Web build  : $(Test-Path -LiteralPath $webIndex -PathType Leaf)"
  exit 0
}

if (Test-TcpListener '127.0.0.1' $HostPort) { throw "Host port $HostPort is already in use." }
if ($Dev) {
  if ($HostPort -eq $WebPort) { throw 'HostPort and WebPort must be different.' }
  if (Test-TcpListener '127.0.0.1' $WebPort) { throw "Web port $WebPort is already in use." }
}

if ($Build -or -not (Test-Path -LiteralPath $hostEntry -PathType Leaf)) {
  if (-not (Test-Path -LiteralPath $typescriptEntry -PathType Leaf)) { throw "TypeScript compiler was not found: $typescriptEntry" }
  $buildExitCode = 1
  Push-Location $repoRoot
  try {
    & $nodePath $typescriptEntry --build $hostTypecheckProject
    $buildExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($buildExitCode -ne 0) { throw "TypeScript workspace build failed with exit code $buildExitCode." }
}

if (-not (Test-Path -LiteralPath $hostEntry -PathType Leaf)) { throw "Host build output was not found: $hostEntry" }

if (-not $Dev -and ($Build -or -not (Test-Path -LiteralPath $webIndex -PathType Leaf))) {
  if (-not (Test-Path -LiteralPath $viteEntry -PathType Leaf)) { throw "Vite was not found: $viteEntry. Install workspace dependencies or build apps/web." }
  $webBuildExitCode = 1
  Push-Location $webRoot
  try {
    & $nodePath $viteEntry build
    $webBuildExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($webBuildExitCode -ne 0) { throw "Web production build failed with exit code $webBuildExitCode." }
}

if (-not $Dev -and -not (Test-Path -LiteralPath $webIndex -PathType Leaf)) { throw "Built Web console was not found: $webIndex" }

$mobileOutput = Join-Path $outputRoot 'mobile'
New-Item -ItemType Directory -Force -Path $mobileOutput | Out-Null
$webStdout = Join-Path $mobileOutput 'web-dev.stdout.log'
$webStderr = Join-Path $mobileOutput 'web-dev.stderr.log'
$cuaStdout = Join-Path $mobileOutput 'cua-daemon.stdout.log'
$cuaStderr = Join-Path $mobileOutput 'cua-daemon.stderr.log'
$webOrigin = if ($Dev) { "http://localhost:$WebPort" } else { "http://localhost:$HostPort" }
$apiOrigin = "http://127.0.0.1:$HostPort"
$previousViteHostOrigin = $env:VITE_HOST_ORIGIN
$previousPath = $env:PATH
$webProcess = $null
$daemonProcess = $null
$ownedDaemon = $false

try {
  if (-not (Test-Path -LiteralPath $cuaBinary -PathType Leaf)) { throw "Configured CUA daemon executable was not found: $cuaBinary" }
  if (-not (Test-CuaReady)) {
    Write-Output 'Starting the configured CUA daemon in the background...'
    $daemonArguments = @('serve', '--socket', $cuaSocket, '--no-overlay')
    $daemonArgumentLine = ($daemonArguments | ForEach-Object { ConvertTo-WindowsArgument ([string] $_) }) -join ' '
    $daemonProcess = Start-Process -FilePath $cuaBinary -ArgumentList $daemonArgumentLine -WindowStyle Hidden -PassThru -RedirectStandardOutput $cuaStdout -RedirectStandardError $cuaStderr
    $ownedDaemon = $true
    $daemonReady = $false
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
      Start-Sleep -Milliseconds 500
      if ($daemonProcess.HasExited) { break }
      if (Test-CuaReady) { $daemonReady = $true; break }
    }
    if (-not $daemonReady) { throw "CUA daemon did not become ready within 10 seconds. See $cuaStdout and $cuaStderr." }
  } else {
    Write-Output "Reusing the CUA daemon already running on $cuaSocket."
  }

  if ($Dev) {
    $nodeDirectory = Split-Path -Parent $nodePath
    $env:PATH = "$nodeDirectory;$previousPath"
    $env:VITE_HOST_ORIGIN = $apiOrigin
    $webArguments = @(
      $pnpmPath,
      '--filter', '@computer-harness/web', 'dev', '--',
      '--host', '127.0.0.1', '--port', [string] $WebPort, '--strictPort'
    )
    $webArgumentLine = ($webArguments | ForEach-Object { ConvertTo-WindowsArgument ([string] $_) }) -join ' '
    $webProcess = Start-Process -FilePath $nodePath -ArgumentList $webArgumentLine -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $webStdout -RedirectStandardError $webStderr

    $webReady = $false
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
      Start-Sleep -Milliseconds 250
      if ($webProcess.HasExited) { throw "Vite exited before becoming ready. See $webStderr" }
      if (Test-TcpListener '127.0.0.1' $WebPort) { $webReady = $true; break }
    }
    if (-not $webReady) { throw "Vite did not become ready within 10 seconds. See $webStdout and $webStderr" }
  }

  $hostArguments = @(
    $hostEntry,
    '--env-file', $envFile,
    '--socket', $cuaSocket,
    '--model', $model,
    '--output', $outputRoot,
    '--port', [string] $HostPort
  )
  if ($Dev) { $hostArguments += @('--origin', $webOrigin) }
  Write-Output "Host API : $apiOrigin (loopback)"
  Write-Output "Connect Phone: $webOrigin"
  if ($Dev) { Write-Output 'Press Ctrl+C to stop the Host, Vite development server, and any CUA daemon started by this launcher.' }
  else { Write-Output 'Press Ctrl+C to stop the Host and any CUA daemon started by this launcher.' }
  & $nodePath @hostArguments
  if ($LASTEXITCODE -ne 0) { throw "Host exited with code $LASTEXITCODE." }
} finally {
  $env:PATH = $previousPath
  if ($null -eq $previousViteHostOrigin) { Remove-Item Env:VITE_HOST_ORIGIN -ErrorAction SilentlyContinue } else { $env:VITE_HOST_ORIGIN = $previousViteHostOrigin }
  if ($null -ne $webProcess -and -not $webProcess.HasExited) {
    $previousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      if (Get-Command taskkill.exe -ErrorAction SilentlyContinue) {
        & taskkill.exe /PID $webProcess.Id /T /F *> $null
      } else {
        Stop-Process -Id $webProcess.Id -Force -ErrorAction SilentlyContinue
      }
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    $webProcess.WaitForExit(5000) | Out-Null
  }
  if ($ownedDaemon -and $null -ne $daemonProcess -and -not $daemonProcess.HasExited) {
    $previousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & $cuaBinary stop --socket $cuaSocket 1>$null 2>$null
      if (-not $daemonProcess.WaitForExit(5000)) { $daemonProcess.Kill() }
    } finally {
      $ErrorActionPreference = $previousPreference
    }
  }
}
