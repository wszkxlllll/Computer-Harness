[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('list', 'show', 'prepare', 'run', 'collect', 'tui')]
  [string] $Command = 'list',

  [ValidatePattern('^T(?:0[1-9]|1[0-9]|20)$')]
  [string] $Task,

  [string] $AnchorDate,

  [ValidateSet('baseline', 'assisted', 'research')]
  [string] $Preset = 'research',

  [ValidateSet('off', 'layered')]
  [string] $RiskGuard,

  [ValidateSet('glm-5.3-flash', 'qwen3.8-flash')]
  [string] $Model,

  [ValidateRange(1, 1000000)]
  [int] $MaxSteps = 100,

  [ValidateRange(1, 1000000)]
  [int] $MaxModelRequests = 100,

  [string] $CuaWindowPid,
  [string] $CuaWindowId,

  [string] $TrialDir,
  [switch] $AllowHeldout,
  [switch] $Yes,
  [switch] $Build
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$travelScript = Join-Path $PSScriptRoot 'travel.mjs'
$harnessScript = Join-Path $repoRoot 'scripts\harness.ps1'
$configPath = Join-Path $repoRoot '.harness.local.psd1'
$selectedRiskGuard = if ($RiskGuard) { $RiskGuard } elseif ($Preset -eq 'research') { 'off' } else { 'layered' }

function Resolve-RepoPath([string] $Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'path is required' }
  if ($Value.IndexOf([char]0) -ge 0 -or $Value.Contains("`r") -or $Value.Contains("`n")) { throw 'path contains an invalid control character' }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Value))
}

function Get-NodePath {
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $config = Import-PowerShellDataFile -LiteralPath $configPath
    if ($config['NodePath']) { return Resolve-RepoPath ([string]$config['NodePath']) }
  }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
  if ($null -eq $command) { throw 'Node executable was not found' }
  return $command.Source
}

function Invoke-Travel([string[]] $Arguments) {
  $node = Get-NodePath
  $previousConsoleEncoding = [Console]::OutputEncoding
  $previousOutputEncoding = $OutputEncoding
  try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    & $node $travelScript @Arguments
    $exitCode = $LASTEXITCODE
  } finally {
    [Console]::OutputEncoding = $previousConsoleEncoding
    $OutputEncoding = $previousOutputEncoding
  }
  if ($exitCode -ne 0) { throw "travel command failed with exit code $exitCode" }
}

function Invoke-TravelJson([string[]] $Arguments) {
  $node = Get-NodePath
  $previousConsoleEncoding = [Console]::OutputEncoding
  $previousOutputEncoding = $OutputEncoding
  try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $lines = & $node $travelScript @Arguments '--json'
  } finally {
    [Console]::OutputEncoding = $previousConsoleEncoding
    $OutputEncoding = $previousOutputEncoding
  }
  if ($LASTEXITCODE -ne 0) { throw "travel command failed with exit code $LASTEXITCODE" }
  $text = ($lines -join [Environment]::NewLine)
  if ([string]::IsNullOrWhiteSpace($text)) { throw 'travel command returned no JSON' }
  return $text | ConvertFrom-Json
}

function Require-TaskAndDate {
  if ([string]::IsNullOrWhiteSpace($Task)) { throw "-$Command requires -Task T01..T20" }
  if ([string]::IsNullOrWhiteSpace($AnchorDate)) { throw "-$Command requires -AnchorDate YYYY-MM-DD" }
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

$cuaWindowArguments = Get-CuaWindowArguments

function Add-HeldoutArgument([System.Collections.Generic.List[string]] $Arguments) {
  if ($AllowHeldout) { [void]$Arguments.Add('--allow-heldout') }
}

function Write-LauncherRecord([string] $TrialPath, [string] $Status, [Nullable[int]] $ExitCode, [string] $Note, [string] $ResolvedRiskGuard) {
  $record = [ordered]@{
    schemaVersion = 1
    kind = 'travel_launcher_attempt'
    recordedAt = [DateTime]::UtcNow.ToString('o')
    status = $Status
    executionStatus = if ($Status -eq 'not_started') { 'not_executed' } else { 'unknown_after_launcher_attempt' }
    exitCode = $ExitCode
    note = $Note
    runtimeDirectory = 'runtime'
    interactive = $true
    profile = 'live-interactive'
    riskGuard = $ResolvedRiskGuard
  }
  $path = Join-Path $TrialPath 'launcher-run.json'
  $json = $record | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Require-LocalConfig {
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Missing .harness.local.psd1; this command requires the local launcher configuration' }
  return Import-PowerShellDataFile -LiteralPath $configPath
}

function Assert-CuaReady([hashtable] $Config) {
  $cuaBinary = Resolve-RepoPath ([string]$Config['CuaBinary'])
  $cuaSocket = [string]$Config['CuaSocket']
  if (-not (Test-Path -LiteralPath $cuaBinary -PathType Leaf)) { throw "CUA daemon executable was not found: $cuaBinary" }
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $cuaBinary status --socket $cuaSocket 1>$null 2>$null
    $status = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($status -ne 0) { throw 'CUA daemon is not ready; start it explicitly with scripts/harness.ps1 daemon' }
}

function New-TuiSessionDirectory {
  $root = Resolve-RepoPath 'runs\travel'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    $id = 'tui-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $path = Join-Path $root $id
    if (Test-Path -LiteralPath $path) { continue }
    New-Item -ItemType Directory -Path $path -ErrorAction Stop | Out-Null
    return @{ Id = $id; Path = $path }
  }
  throw 'Could not allocate a unique TUI travel session directory'
}

function Write-TuiSessionRecord([string] $SessionPath, [System.Collections.IDictionary] $Record) {
  $path = Join-Path $SessionPath 'session.json'
  [IO.File]::WriteAllText($path, (($Record | ConvertTo-Json -Depth 8) + "`n"), [System.Text.UTF8Encoding]::new($false))
}

function Start-TuiCollector([string] $SessionPath) {
  $collectorScript = Join-Path $PSScriptRoot 'tui-collector.mjs'
  if (-not (Test-Path -LiteralPath $collectorScript -PathType Leaf)) { throw 'TUI session collector is unavailable: scripts/travel/tui-collector.mjs is missing' }
  $stopFile = Join-Path $SessionPath 'collector.stop'
  $readyFile = Join-Path $SessionPath 'collector.ready'
  $stdoutPath = Join-Path $SessionPath 'collector.stdout.log'
  $stderrPath = Join-Path $SessionPath 'collector.stderr.log'
  $node = Get-NodePath
  $arguments = @($collectorScript, 'watch', '--session-dir', $SessionPath, '--stop-file', $stopFile, '--ready-file', $readyFile)
  $argumentLine = ($arguments | ForEach-Object {
      $value = [string]$_
      if ($value -match '[\s"]') { '"' + $value.Replace('"', '\"') + '"' } else { $value }
    }) -join ' '
  try {
    $process = Start-Process -FilePath $node -ArgumentList $argumentLine -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
      if (Test-Path -LiteralPath $readyFile -PathType Leaf) {
        return @{ Process = $process; StopFile = $stopFile; ReadyFile = $readyFile; FinalizeStdout = (Join-Path $SessionPath 'collector.finalize.stdout.log'); FinalizeStderr = (Join-Path $SessionPath 'collector.finalize.stderr.log') }
      }
      if ($process.HasExited) { throw 'TUI session collector exited before ready-file creation' }
      Start-Sleep -Milliseconds 100
    }
    throw 'TUI session collector did not create ready-file within 5 seconds'
  } catch {
    if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    throw
  }
}

function Stop-TuiCollector([hashtable] $Collector) {
  if ($null -eq $Collector) { return }
  [IO.File]::WriteAllText([string]$Collector.StopFile, "stop`n", [System.Text.UTF8Encoding]::new($false))
  $process = $Collector.Process
  for ($attempt = 0; $attempt -lt 30 -and -not $process.HasExited; $attempt += 1) { Start-Sleep -Milliseconds 200 }
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}

function Finalize-TuiCollector([string] $SessionPath, [hashtable] $Collector) {
  if ($null -eq $Collector) { return 1 }
  $collectorScript = Join-Path $PSScriptRoot 'tui-collector.mjs'
  $node = Get-NodePath
  & $node $collectorScript 'collect' '--session-dir' $SessionPath 1> $Collector.FinalizeStdout 2> $Collector.FinalizeStderr
  return $LASTEXITCODE
}

switch ($Command) {
  'tui' {
    if (-not [string]::IsNullOrWhiteSpace($Task) -or -not [string]::IsNullOrWhiteSpace($AnchorDate) -or -not [string]::IsNullOrWhiteSpace($TrialDir) -or $AllowHeldout) {
      throw '-Command tui does not accept single-task options (-Task, -AnchorDate, -TrialDir, or -AllowHeldout). Enter the goal in the TUI instead.'
    }
    $config = Require-LocalConfig
    Assert-CuaReady $config
    $selectedModel = if ($Model) { $Model } elseif ($config['Model']) { [string]$config['Model'] } else { 'glm-5.3-flash' }
    $session = New-TuiSessionDirectory
    $sessionPath = [string]$session.Path
    $sessionRelative = $sessionPath.Substring($repoRoot.Length).TrimStart([char]92, [char]47).Replace('\', '/')
    $sessionRecord = [ordered]@{
      schemaVersion = 1
      kind = 'travel_tui_session'
      sessionId = [string]$session.Id
      sessionDirectory = $sessionRelative
      runtimePattern = "$sessionRelative/run-*"
      status = 'prepared'
      createdAt = [DateTime]::UtcNow.ToString('o')
      goalSource = 'tui_input'
      runsAreIndependent = $true
      model = $selectedModel
      preset = $Preset
      maxSteps = $MaxSteps
      maxModelRequests = $MaxModelRequests
      interactive = $true
      profile = 'live-interactive'
      riskGuard = $selectedRiskGuard
      collector = [ordered]@{ status = 'not_started'; watch = $true; ownsOnlyItsProcess = $true }
      businessOutcome = 'manual_pending'
    }
    Write-TuiSessionRecord $sessionPath $sessionRecord
    Write-Output "TUI session directory: $sessionPath"
    $collector = $null
    $tuiExit = 1
    $tuiError = $null
    try {
      $collector = Start-TuiCollector $sessionPath
      $sessionRecord.status = 'running'
      $sessionRecord.collector = [ordered]@{ status = 'running'; watch = $true; ownsOnlyItsProcess = $true }
      Write-TuiSessionRecord $sessionPath $sessionRecord
      $harnessParams = @{
        Command = 'tui'
        Preset = $Preset
        Model = $selectedModel
        OutputDir = $sessionPath
        MaxSteps = $MaxSteps
        MaxModelRequests = $MaxModelRequests
        AllowExistingOutputDir = $true
        RiskGuard = $selectedRiskGuard
      }
      if ($cuaWindowArguments.Count -gt 0) {
        $harnessParams['CuaWindowPid'] = $CuaWindowPid
        $harnessParams['CuaWindowId'] = $CuaWindowId
      }
      if ($Build) { $harnessParams['Build'] = $true }
      & $harnessScript @harnessParams
      $tuiExit = $LASTEXITCODE
    } catch {
      $tuiError = $_
      $tuiExit = 1
    } finally {
      try { Stop-TuiCollector $collector } catch { $sessionRecord.collector = [ordered]@{ status = 'stop_failed'; watch = $true; ownsOnlyItsProcess = $true } }
      $finalizeExit = 1
      try { $finalizeExit = Finalize-TuiCollector $sessionPath $collector } catch { $finalizeExit = 1 }
      $sessionRecord.status = if ($tuiError -eq $null -and $tuiExit -eq 0) { 'finished' } else { 'failed' }
      $sessionRecord.finishedAt = [DateTime]::UtcNow.ToString('o')
      $sessionRecord.tuiExitCode = $tuiExit
      $sessionRecord.collector = [ordered]@{ status = if ($finalizeExit -eq 0) { 'finalized' } else { 'finalize_failed' }; watch = $true; ownsOnlyItsProcess = $true; finalizeExitCode = $finalizeExit }
      Write-TuiSessionRecord $sessionPath $sessionRecord
      $sessionTerminalStatus = if ($tuiError -eq $null -and $tuiExit -eq 0) { 'finished' } else { 'failed/stopped' }
      Write-Output "TUI session $sessionTerminalStatus; per-Run artifacts are under $sessionPath\run-*"
      if ($finalizeExit -ne 0) { Write-Warning "TUI collector finalization failed; inspect $sessionPath\collector.finalize.stderr.log before treating records as complete." }
    }
    if ($tuiError -ne $null) { throw $tuiError }
    exit $tuiExit
  }
  'list' {
    Invoke-Travel @('list')
    exit 0
  }
  'show' {
    Require-TaskAndDate
    $args = [System.Collections.Generic.List[string]]::new()
    [void]$args.Add('show'); [void]$args.Add('--task'); [void]$args.Add($Task); [void]$args.Add('--anchor-date'); [void]$args.Add($AnchorDate)
    Add-HeldoutArgument $args
    Invoke-Travel $args.ToArray()
    exit 0
  }
  'prepare' {
    Require-TaskAndDate
    $args = [System.Collections.Generic.List[string]]::new()
    [void]$args.Add('prepare'); [void]$args.Add('--task'); [void]$args.Add($Task); [void]$args.Add('--anchor-date'); [void]$args.Add($AnchorDate)
    [void]$args.Add('--preset'); [void]$args.Add($Preset)
    if ($Model) { [void]$args.Add('--model'); [void]$args.Add($Model) }
    [void]$args.Add('--max-steps'); [void]$args.Add([string]$MaxSteps)
    [void]$args.Add('--max-model-requests'); [void]$args.Add([string]$MaxModelRequests)
    Add-HeldoutArgument $args
    Invoke-Travel $args.ToArray()
    exit 0
  }
  'collect' {
    if ([string]::IsNullOrWhiteSpace($TrialDir)) { throw '-collect requires -TrialDir' }
    $resolvedTrial = Resolve-RepoPath $TrialDir
    Invoke-Travel @('collect', '--trial-dir', $resolvedTrial)
    exit 0
  }
  'run' {
    Require-TaskAndDate
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Missing .harness.local.psd1; run requires the local launcher configuration' }
    $config = Import-PowerShellDataFile -LiteralPath $configPath
    $selectedModel = if ($Model) { $Model } elseif ($config['Model']) { [string]$config['Model'] } else { 'glm-5.3-flash' }
    $prepareArgs = [System.Collections.Generic.List[string]]::new()
    [void]$prepareArgs.Add('prepare'); [void]$prepareArgs.Add('--task'); [void]$prepareArgs.Add($Task); [void]$prepareArgs.Add('--anchor-date'); [void]$prepareArgs.Add($AnchorDate)
    [void]$prepareArgs.Add('--preset'); [void]$prepareArgs.Add($Preset); [void]$prepareArgs.Add('--model'); [void]$prepareArgs.Add($selectedModel)
    [void]$prepareArgs.Add('--max-steps'); [void]$prepareArgs.Add([string]$MaxSteps); [void]$prepareArgs.Add('--max-model-requests'); [void]$prepareArgs.Add([string]$MaxModelRequests)
    Add-HeldoutArgument $prepareArgs
    $prepared = Invoke-TravelJson $prepareArgs.ToArray()
    $trialPath = Resolve-RepoPath ([string]$prepared.trialDirectory)
    $runtimePath = Join-Path $trialPath 'runtime'
    $goalPath = Join-Path $trialPath 'goal.txt'
    $goalText = Get-Content -LiteralPath $goalPath -Raw -Encoding UTF8
    Write-Output "Prepared $($prepared.taskId) at $trialPath"
    Write-Output "Preset: $Preset; Model: $selectedModel; MaxSteps: $MaxSteps; MaxModelRequests: $MaxModelRequests"
    Write-Output 'Goal:'
    Write-Output $goalText
    if (-not $Yes) {
      $confirmation = Read-Host 'Type RUN to start this one interactive trial (anything else cancels)'
      if ($confirmation -cne 'RUN') {
        Write-LauncherRecord $trialPath 'not_started' $null 'User did not confirm RUN' $selectedRiskGuard
        Write-Output 'Cancelled before launcher start.'
        exit 2
      }
    }
    $cuaBinary = Resolve-RepoPath ([string]$config['CuaBinary'])
    $cuaSocket = [string]$config['CuaSocket']
    if (-not (Test-Path -LiteralPath $cuaBinary -PathType Leaf)) { throw "CUA daemon executable was not found: $cuaBinary" }
    $previousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & $cuaBinary status --socket $cuaSocket 1>$null 2>$null
      $cuaStatus = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($cuaStatus -ne 0) { throw 'CUA daemon is not ready; start it explicitly with scripts/harness.ps1 daemon' }
    Write-LauncherRecord $trialPath 'started' $null 'Launcher invocation started after explicit confirmation; business outcome remains manual.' $selectedRiskGuard
    $launcherExit = 1
    $launcherError = $null
    try {
      $harnessParams = @{
        Command = 'run'
        Preset = $Preset
        Model = $selectedModel
        Goal = $goalText
        OutputDir = $runtimePath
        MaxSteps = $MaxSteps
        MaxModelRequests = $MaxModelRequests
        RiskGuard = $selectedRiskGuard
      }
      if ($cuaWindowArguments.Count -gt 0) {
        $harnessParams['CuaWindowPid'] = $CuaWindowPid
        $harnessParams['CuaWindowId'] = $CuaWindowId
      }
      if ($Build) { $harnessParams['Build'] = $true }
      & $harnessScript @harnessParams
      $launcherExit = $LASTEXITCODE
    } catch {
      $launcherError = $_
      $launcherExit = 1
    } finally {
      Write-LauncherRecord $trialPath $(if ($launcherError -eq $null -and $launcherExit -eq 0) { 'completed' } else { 'failed' }) $launcherExit 'Runtime exit status is not a business success judgement; fill manual-review.md.' $selectedRiskGuard
    }
    try {
      Invoke-Travel @('collect', '--trial-dir', $trialPath)
    } catch {
      Write-Warning ("Collection failed; preserving launcher exit status: " + $_.Exception.Message)
    }
    if ($launcherError -ne $null) { throw $launcherError }
    exit $launcherExit
  }
}

throw "Unknown travel command: $Command"
