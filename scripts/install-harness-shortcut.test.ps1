$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $PSScriptRoot 'install-harness-shortcut.ps1'
foreach ($path in @($installer, (Join-Path $PSScriptRoot 'harness.ps1'))) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) { throw "PowerShell parse failed: $path" }
}

$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('harness-shortcut-fixture-' + [Guid]::NewGuid().ToString('N'))
$sandboxFull = [IO.Path]::GetFullPath($sandbox)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $sandboxFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $sandboxFull) -notlike 'harness-shortcut-fixture-*') {
  throw "Refusing to use an unexpected fixture path: $sandboxFull"
}

try {
  $startMenu = Join-Path $sandbox 'injected-start-menu'
  $desktop = Join-Path $sandbox 'injected-desktop'
  & $installer -Destination Both -StartMenuDirectory $startMenu -DesktopDirectory $desktop | Out-Null
  $expectedLinkName = 'Computer Harness Pi.lnk'
  $links = @((Join-Path $startMenu $expectedLinkName), (Join-Path $desktop $expectedLinkName))
  foreach ($linkPath in $links) {
    if (-not (Test-Path -LiteralPath $linkPath -PathType Leaf)) { throw "Expected injected shortcut was not created: $linkPath" }
    $shortcut = [HarnessShortcutNative]::Read($linkPath)
    $powerShellExecutable = (Get-Process -Id $PID).Path
    $harnessScript = Join-Path $repoRoot 'scripts\harness.ps1'
    if ($shortcut[0] -ne $powerShellExecutable) { throw 'Shortcut does not target the current PowerShell host.' }
    $actualWorkingDirectory = [IO.Path]::GetFullPath([string]$shortcut[1]).TrimEnd('\')
    if ($actualWorkingDirectory -ne $repoRoot.TrimEnd('\')) { throw 'Shortcut working directory does not point to this repository.' }
    if ($shortcut[2] -notmatch [regex]::Escape($harnessScript) -or $shortcut[2] -notmatch '\sstart$') {
      throw 'Shortcut does not invoke this repository harness.ps1 start entry.'
    }
    if ($shortcut[2] -match '(?i)\.env|\.harness\.local|api[_-]?key|token') {
      throw 'Shortcut unexpectedly contains local configuration or credential material.'
    }
  }

  $collisionRoot = Join-Path $sandbox 'collision-fixture'
  $collisionMenu = Join-Path $collisionRoot 'menu'
  $collisionDesktop = Join-Path $collisionRoot 'desktop'
  New-Item -ItemType Directory -Force -Path $collisionMenu | Out-Null
  $existingLink = Join-Path $collisionMenu $expectedLinkName
  [IO.File]::WriteAllText($existingLink, 'preserve-existing-shortcut')
  $collisionRejected = $false
  try {
    & $installer -Destination Both -StartMenuDirectory $collisionMenu -DesktopDirectory $collisionDesktop | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch 'will not be overwritten') { throw }
    $collisionRejected = $true
  }
  if (-not $collisionRejected) { throw 'Installer did not reject an existing same-name shortcut.' }
  if ([IO.File]::ReadAllText($existingLink) -ne 'preserve-existing-shortcut') { throw 'Installer changed the existing shortcut fixture.' }
  if (Test-Path -LiteralPath $collisionDesktop) { throw 'Both-mode collision left a partial Desktop shortcut installation.' }

  Write-Output 'Shortcut installer syntax, injected-directory, target, working-directory, no-secret, and no-overwrite checks passed.'
} finally {
  $resolvedSandbox = [IO.Path]::GetFullPath($sandbox)
  if (-not $resolvedSandbox.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedSandbox) -notlike 'harness-shortcut-fixture-*') {
    throw "Refusing to clean an unexpected fixture path: $resolvedSandbox"
  }
  if (Test-Path -LiteralPath $resolvedSandbox -PathType Container) {
    Remove-Item -LiteralPath $resolvedSandbox -Recurse -Force
  }
}
