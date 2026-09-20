$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$paths = @(
  (Join-Path $PSScriptRoot 'run.ps1'),
  (Join-Path $repoRoot 'scripts\harness.ps1')
)

foreach ($path in $paths) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    throw "PowerShell parse failed: $path"
  }
}

$harnessText = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\harness.ps1') -Raw -Encoding UTF8
foreach ($required in @('$OutputDir', '$MaxSteps', '$MaxModelRequests', '$CuaWindowPid', '$CuaWindowId', '$AllowExistingOutputDir', '$RiskGuard', '$selectedRiskGuard', 'PnpmCliPath', 'HARNESS_BUILD_NODE_EXE', 'HARNESS_BUILD_PNPM_CLI', "'--output'", "'--max-steps'", "'--max-model-requests'", "'--profile', 'live-interactive'", "'--risk-guard', $selectedRiskGuard", "'--confirm-risk-guard-off'", "'--cua-window-pid'", "'--cua-window-id'")) {
  if (-not $harnessText.Contains($required)) {
    throw "Harness output binding or safety argument is missing: $required"
  }
}

$travelText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'run.ps1') -Raw -Encoding UTF8
foreach ($required in @('$harnessParams', '$CuaWindowPid', '$CuaWindowId', '$RiskGuard', '$selectedRiskGuard', 'RiskGuard = $selectedRiskGuard', 'Command = ''run''', 'OutputDir = $runtimePath', 'Type RUN', "'tui'", 'travel_tui_session', 'Start-TuiCollector', 'tui-collector.mjs', "'watch'", '--ready-file', "'collect'", 'AllowExistingOutputDir')) {
  if (-not $travelText.Contains($required)) {
    throw "Travel launcher contract is missing: $required"
  }
}

$tuiParameterRejected = $false
try {
  & (Join-Path $PSScriptRoot 'run.ps1') -Command tui -Task T01 -AnchorDate 2026-09-20 -AllowHeldout
} catch {
  if ($_.Exception.Message -match 'does not accept single-task options') { $tuiParameterRejected = $true } else { throw }
}
if (-not $tuiParameterRejected) { throw 'TUI unexpectedly accepted single-task options' }

$halfWindowParameterRejected = $false
try {
  & (Join-Path $PSScriptRoot 'run.ps1') -Command tui -CuaWindowPid 1234
} catch {
  if ($_.Exception.Message -match 'must be provided together') { $halfWindowParameterRejected = $true } else { throw }
}
if (-not $halfWindowParameterRejected) { throw 'Travel launcher unexpectedly accepted a half-specified window target' }

function Write-Utf8NoBom([string] $Path, [string] $Text) {
  [IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

# Offline launcher stub: exercise the real harness parameter binding without
# starting the model, CUA daemon, or desktop. The fake CLI only records argv.
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('travel-launcher-stub-' + [Guid]::NewGuid().ToString('N'))
$sandboxFull = [IO.Path]::GetFullPath($sandbox)
$tempRootFull = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $sandboxFull.StartsWith($tempRootFull, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $sandboxFull) -notlike 'travel-launcher-stub-*') {
  throw "refusing to use an unexpected stub sandbox path: $sandboxFull"
}
$previousPath = $env:PATH
try {
  $fakeCli = Join-Path $sandbox 'apps\cli\dist\index.js'
  $fakeScripts = Join-Path $sandbox 'scripts'
  $fakeOutput = Join-Path $sandbox 'bound-output'
  $fakeArgsPath = Join-Path $sandbox 'fake-args.json'
  $fakePnpm = Join-Path $sandbox 'fake-pnpm.mjs'
  $fakePnpmArgsPath = Join-Path $sandbox 'fake-pnpm-args.jsonl'
  $fakeEnv = Join-Path $sandbox 'dummy.env'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $fakeCli), $fakeScripts | Out-Null
  Write-Utf8NoBom $fakeCli "const fs = require('node:fs'); fs.writeFileSync(process.env.FAKE_ARGS_PATH, JSON.stringify(process.argv.slice(2)), 'utf8');"
  Write-Utf8NoBom $fakePnpm @'
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (process.env.FAKE_PNPM_ARGS_PATH) appendFileSync(process.env.FAKE_PNPM_ARGS_PATH, JSON.stringify(args) + "\n", "utf8");
if (process.env.FAKE_PNPM_FAIL) process.exit(Number(process.env.FAKE_PNPM_FAIL));
if (args[0] === "run" && args[1] === "build") {
  const nested = spawnSync(process.execPath, [process.env.HARNESS_BUILD_PNPM_CLI, "exec", "nested-check"], { stdio: "ignore" });
  process.exit(nested.status === null ? 1 : nested.status);
}
process.exit(0);
'@
  Write-Utf8NoBom $fakeEnv ''
  Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\harness.ps1') -Destination (Join-Path $fakeScripts 'harness.ps1')
  $hostConfig = Import-PowerShellDataFile -LiteralPath (Join-Path $repoRoot '.harness.local.psd1')
  $configuredNode = [string]$hostConfig['NodePath']
  if (-not [IO.Path]::IsPathRooted($configuredNode)) { $configuredNode = [IO.Path]::GetFullPath((Join-Path $repoRoot $configuredNode)) }
  if (-not (Test-Path -LiteralPath $configuredNode -PathType Leaf)) { throw 'configured NodePath is unavailable for the offline stub' }
  $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
  $pathWithoutPnpm = @($previousPath -split ';' | Where-Object { $_ -and $_ -notmatch '(?i)pnpm' -and $_ -notmatch '(?i)codex-primary-runtime.*dependencies[\\/]bin[\\/]fallback' }) -join ';'
  $env:PATH = "$(Split-Path -Parent $configuredNode);$pathWithoutPnpm"
  if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) { throw 'pnpm.cmd unexpectedly remained on the offline stub PATH' }
  $node = 'node-shim.cmd'
  Write-Utf8NoBom (Join-Path $sandbox $node) "@echo off`r`nnode %*`r`n"
  $escape = { param([string]$Value) $Value.Replace("'", "''") }
  $configText = @"
@{
  NodePath = '$(&$escape $node)'
  PnpmCliPath = 'fake-pnpm.mjs'
  EnvFile = 'dummy.env'
  CuaBinary = '$(&$escape $pwsh)'
  CuaSocket = 'stub-socket'
  Model = 'glm-5.3-flash'
  Preset = 'research'
  OutputRoot = 'outputs'
  MemoryEmbeddingEndpoint = ''
}
"@
  Write-Utf8NoBom (Join-Path $sandbox '.harness.local.psd1') $configText
  $goalText = @([char]0x4e0a, [char]0x6d77, [char]0x67e5, [char]0x8be2) -join ''
  $previousFakeArgs = $env:FAKE_ARGS_PATH
  $env:FAKE_ARGS_PATH = $fakeArgsPath
  try {
    & (Join-Path $fakeScripts 'harness.ps1') -Command run -Preset research -Model glm-5.3-flash -Goal $goalText -OutputDir $fakeOutput -MaxSteps 30 -MaxModelRequests 40 -CuaWindowPid 1234 -CuaWindowId 5678
    if ($LASTEXITCODE -ne 0) { throw "stub launcher returned exit code $LASTEXITCODE" }
  } finally {
    if ($null -eq $previousFakeArgs) { Remove-Item Env:FAKE_ARGS_PATH -ErrorAction SilentlyContinue } else { $env:FAKE_ARGS_PATH = $previousFakeArgs }
  }
  $argv = [string[]](Get-Content -LiteralPath $fakeArgsPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  function Assert-ArgPair([string[]] $Values, [string] $Name, [string] $Expected) {
    $index = [Array]::IndexOf($Values, $Name)
    if ($index -lt 0 -or $Values[$index + 1] -ne $Expected) { throw "stub argv missing $Name=$Expected (actual=$($Values[$index + 1]))" }
  }
  Assert-ArgPair $argv '--goal' $goalText
  Assert-ArgPair $argv '--output' $fakeOutput
  Assert-ArgPair $argv '--max-steps' '30'
  Assert-ArgPair $argv '--max-model-requests' '40'
  Assert-ArgPair $argv '--profile' 'live-interactive'
  Assert-ArgPair $argv '--risk-guard' 'off'
  if (-not ($argv -contains '--confirm-risk-guard-off')) { throw 'stub argv is missing explicit Guard-off confirmation' }
  Assert-ArgPair $argv '--cua-window-pid' '1234'
  Assert-ArgPair $argv '--cua-window-id' '5678'
  $buildOutput = Join-Path $sandbox 'build-output'
  $pathBeforeBuild = $env:PATH
  $previousPnpmArgs = $env:FAKE_PNPM_ARGS_PATH
  $previousPnpmFail = $env:FAKE_PNPM_FAIL
  $env:FAKE_ARGS_PATH = $fakeArgsPath
  $env:FAKE_PNPM_ARGS_PATH = $fakePnpmArgsPath
  Remove-Item Env:FAKE_PNPM_FAIL -ErrorAction SilentlyContinue
  try {
    & (Join-Path $fakeScripts 'harness.ps1') -Command run -Build -Preset research -Model glm-5.3-flash -Goal $goalText -OutputDir $buildOutput
    if ($LASTEXITCODE -ne 0) { throw "stub build returned exit code $LASTEXITCODE" }
    if ($env:PATH -ne $pathBeforeBuild) { throw 'build did not restore PATH after success' }
    $pnpmLines = @(Get-Content -LiteralPath $fakePnpmArgsPath -Encoding UTF8)
    if ($pnpmLines.Count -lt 2) { throw 'nested pnpm invocation was not observed' }
    $outerPnpmArgs = $pnpmLines[0] | ConvertFrom-Json
    $nestedPnpmArgs = $pnpmLines[1] | ConvertFrom-Json
    if ($outerPnpmArgs[0] -ne 'run' -or $outerPnpmArgs[1] -ne 'build') { throw 'configured pnpm did not receive run build' }
    if ($nestedPnpmArgs[0] -ne 'exec' -or $nestedPnpmArgs[1] -ne 'nested-check') { throw 'nested pnpm did not resolve through the temporary shim' }
    $env:FAKE_PNPM_FAIL = '7'
    $buildFailed = $false
    try {
      & (Join-Path $fakeScripts 'harness.ps1') -Command run -Build -Preset research -Model glm-5.3-flash -Goal $goalText -OutputDir (Join-Path $sandbox 'failed-build-output')
    } catch {
      if ($_.Exception.Message -notmatch 'Build failed with exit code 7') { throw "unexpected configured pnpm failure: $($_.Exception.Message)" }
      $buildFailed = $true
    }
    if (-not $buildFailed) { throw 'configured pnpm failure was not propagated' }
    if ($env:PATH -ne $pathBeforeBuild) { throw 'build did not restore PATH after failure' }
  } finally {
    if ($null -eq $previousPnpmArgs) { Remove-Item Env:FAKE_PNPM_ARGS_PATH -ErrorAction SilentlyContinue } else { $env:FAKE_PNPM_ARGS_PATH = $previousPnpmArgs }
    if ($null -eq $previousPnpmFail) { Remove-Item Env:FAKE_PNPM_FAIL -ErrorAction SilentlyContinue } else { $env:FAKE_PNPM_FAIL = $previousPnpmFail }
  }
  $nonEmpty = Join-Path $sandbox 'non-empty'
  New-Item -ItemType Directory -Force -Path $nonEmpty | Out-Null
  Write-Utf8NoBom (Join-Path $nonEmpty 'existing.txt') 'existing'
  $rejected = $false
  try {
    & (Join-Path $fakeScripts 'harness.ps1') -Command run -Preset research -Model glm-5.3-flash -Goal $goalText -OutputDir $nonEmpty -MaxSteps 30 -MaxModelRequests 40
  } catch {
    $rejectionMessage = $_.Exception.Message
    if ($rejectionMessage -notmatch 'must be empty') { throw "unexpected non-empty-directory rejection: $rejectionMessage" }
    $rejected = $true
  }
  if (-not $rejected) { throw 'non-empty bound output directory was not rejected' }
  Write-Output 'travel PowerShell parse and offline launcher-stub checks passed'
} finally {
  $env:PATH = $previousPath
  if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}

# Offline TUI/session stub: verifies that two independent Run directories are
# retained under one session and that the collector contract is finalized.
$tuiLabel = @([char]0x6d4b, [char]0x8bd5) -join ''
$tuiSandbox = Join-Path ([IO.Path]::GetTempPath()) ('travel tui stub-' + $tuiLabel + '-' + [Guid]::NewGuid().ToString('N'))
$tuiSandboxFull = [IO.Path]::GetFullPath($tuiSandbox)
$tempRootFull = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $tuiSandboxFull.StartsWith($tempRootFull, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $tuiSandboxFull) -notlike 'travel tui stub-*') {
  throw "refusing to use an unexpected TUI stub sandbox path: $tuiSandboxFull"
}
$previousTuiPath = $env:PATH
try {
  $fakeTravel = Join-Path $tuiSandbox 'scripts\travel'
  $fakeApps = Join-Path $tuiSandbox 'apps\cli\dist'
  New-Item -ItemType Directory -Force -Path $fakeTravel, $fakeApps | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run.ps1') -Destination (Join-Path $fakeTravel 'run.ps1')
  $fakeMetrics = @'
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const session = value("--session-dir");
if (args[0] === "watch") {
  const stop = value("--stop-file");
  writeFileSync(value("--ready-file"), "ready\n", "utf8");
  const timer = setInterval(() => { if (stop !== undefined && existsSync(stop)) { clearInterval(timer); process.exit(0); } }, 25);
} else if (args[0] === "collect") {
  writeFileSync(join(session, "tui-summary.json"), JSON.stringify({ kind: "travel_tui_summary", runDirectories: ["run-1", "run-2"] }) + "\n", "utf8");
} else {
  process.exitCode = 2;
}
'@
  Write-Utf8NoBom (Join-Path $fakeTravel 'tui-collector.mjs') $fakeMetrics
  $fakeHarness = @'
param(
  [string]$Command,
  [string]$Preset,
  [string]$Model,
  [string]$OutputDir,
  [int]$MaxSteps,
  [int]$MaxModelRequests,
  [string]$CuaWindowPid,
  [string]$CuaWindowId,
  [switch]$AllowExistingOutputDir
)
if ($Command -ne 'tui' -or -not $AllowExistingOutputDir -or $CuaWindowPid -ne '1234' -or $CuaWindowId -ne '5678') { throw 'fake TUI harness contract mismatch' }
foreach ($runName in @('run-1', 'run-2')) {
  $run = Join-Path $OutputDir $runName
  New-Item -ItemType Directory -Force -Path $run | Out-Null
  Set-Content -LiteralPath (Join-Path $run 'summary.json') -Value '{"runtimeOutcome":"succeeded"}' -Encoding UTF8
}
exit 0
'@
  Write-Utf8NoBom (Join-Path $tuiSandbox 'scripts\harness.ps1') $fakeHarness
  $fakeCua = @'
param([string]$Action, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
exit 0
'@
  Write-Utf8NoBom (Join-Path $tuiSandbox 'fake-cua.ps1') $fakeCua
  $configuredNode = [string]$hostConfig['NodePath']
  if (-not [IO.Path]::IsPathRooted($configuredNode)) { $configuredNode = [IO.Path]::GetFullPath((Join-Path $repoRoot $configuredNode)) }
  $envFile = Join-Path $tuiSandbox 'dummy.env'
  Write-Utf8NoBom $envFile ''
  $nodeShim = Join-Path $tuiSandbox 'node-shim.cmd'
  Write-Utf8NoBom $nodeShim "@echo off`r`nnode %*`r`n"
  $tuiConfig = @"
@{
  NodePath = 'node-shim.cmd'
  EnvFile = 'dummy.env'
  CuaBinary = 'fake-cua.ps1'
  CuaSocket = 'stub-socket'
  Model = 'glm-5.3-flash'
  Preset = 'research'
  OutputRoot = 'outputs'
  MemoryEmbeddingEndpoint = ''
}
"@
  Write-Utf8NoBom (Join-Path $tuiSandbox '.harness.local.psd1') $tuiConfig
  $env:PATH = "$(Split-Path -Parent $configuredNode);$previousTuiPath"
  & (Join-Path $fakeTravel 'run.ps1') -Command tui -Model glm-5.3-flash -MaxSteps 30 -MaxModelRequests 40 -CuaWindowPid 1234 -CuaWindowId 5678
  if ($LASTEXITCODE -ne 0) { throw "fake TUI launcher returned exit code $LASTEXITCODE" }
  $sessionPath = (Get-ChildItem -LiteralPath (Join-Path $tuiSandbox 'runs\travel') -Directory -Filter 'tui-*' | Select-Object -First 1).FullName
  $session = Get-Content -LiteralPath (Join-Path $sessionPath 'session.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($session.kind -ne 'travel_tui_session' -or $session.status -ne 'finished' -or $session.goalSource -ne 'tui_input' -or $session.PSObject.Properties.Name -contains 'goal') { throw 'TUI session metadata contract failed' }
  $summary = Get-Content -LiteralPath (Join-Path $sessionPath 'tui-summary.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($summary.kind -ne 'travel_tui_summary') { throw 'TUI collector finalization was not recorded' }
  if (@(Get-ChildItem -LiteralPath $sessionPath -Directory -Filter 'run-*').Count -ne 2) { throw 'TUI fake did not retain two independent Run directories' }
  Write-Output 'travel TUI fake-session checks passed'
} finally {
  $env:PATH = $previousTuiPath
  if (Test-Path -LiteralPath $tuiSandbox) { Remove-Item -LiteralPath $tuiSandbox -Recurse -Force }
}
