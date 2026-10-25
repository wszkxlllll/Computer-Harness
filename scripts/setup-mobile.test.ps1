$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot 'setup-mobile.ps1'
$setupBytes = [IO.File]::ReadAllBytes($scriptPath)
if ($setupBytes[0] -ne 0xEF -or $setupBytes[1] -ne 0xBB -or $setupBytes[2] -ne 0xBF) { throw 'Chinese setup source requires a UTF-8 BOM for Windows PowerShell 5.1.' }
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $tokens, [ref] $parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Setup script failed PowerShell parsing.' }
# Load only function definitions: do not run the production entry point.
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  Invoke-Expression $definition.Extent.Text
}

function Assert([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw $Message }
}
function Assert-Throws([scriptblock] $Action, [string] $Message) {
  $thrown = $false
  try { & $Action | Out-Null } catch { $thrown = $true }
  Assert $thrown $Message
}

$testRoot = Join-Path $repoRoot ('.cache\setup-mobile-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
try {
  # UTF-8 round-trip, BOM support for PS 5.1, and CreateNew collision protection.
  $unicodeText = [string][char]0x4E2D + [char]0x6587
  $utf8Path = Join-Path $testRoot 'utf8.txt'
  Write-NewUtf8File $utf8Path $unicodeText
  Assert ([IO.File]::ReadAllText($utf8Path, [Text.UTF8Encoding]::new($false, $true)) -eq $unicodeText) 'UTF-8 round-trip failed.'
  Assert-Throws { Write-NewUtf8File $utf8Path 'replacement' } 'An existing file was overwritten.'
  Assert ([IO.File]::ReadAllText($utf8Path, [Text.Encoding]::UTF8) -eq $unicodeText) 'Collision changed existing content.'
  $bomPath = Join-Path $testRoot 'bom.psd1'
  Write-NewUtf8File $bomPath "@{ Value = '$unicodeText' }" -WithBom
  Assert ((Import-PowerShellDataFile -LiteralPath $bomPath).Value -eq $unicodeText) 'PowerShell data-file Unicode round-trip failed.'
  $originalWriter = ${function:Write-FileBytes}
  function Write-FileBytes {
    param([string] $Path, [byte[]] $Bytes)
    [IO.File]::WriteAllBytes($Path, [byte[]]@($Bytes[0]))
    throw 'Simulated disk write failure after partial content.'
  }
  $failedWritePath = Join-Path $testRoot 'failed.env'
  Assert-Throws { Write-NewUtf8File $failedWritePath 'complete=expected' } 'Partial disk write was accepted.'
  Assert (-not (Test-Path -LiteralPath $failedWritePath)) 'A partial env file was published.'
  Assert (@(Get-ChildItem -LiteralPath $testRoot -Filter '.env.setup-*.tmp' -Force).Count -eq 0) 'A failed private write left a temporary file.'
  Set-Item -Path Function:\Write-FileBytes -Value $originalWriter
  Write-NewUtf8File $failedWritePath 'complete=expected'
  Assert ([IO.File]::ReadAllText($failedWritePath) -eq 'complete=expected') 'A failed write prevented a clean retry.'

  Assert ((Get-RelayOrigin 'https://relay.example.com/') -eq 'https://relay.example.com') 'HTTPS origin was not normalized.'
  foreach ($badOrigin in @('http://relay.example.com', 'https://localhost', 'https://relay.example.com/path', 'https://user:secret@relay.example.com', 'https://relay.example.com/?token=x')) {
    Assert-Throws { Get-RelayOrigin $badOrigin } 'Unsafe or unusable Relay origin was accepted.'
  }
  Assert-EnvValue ('a' * 43) 'fixture' 32
  foreach ($badSecret in @('', ' too-short', "a`nb", '"quoted"')) {
    Assert-Throws { Assert-EnvValue $badSecret 'fixture' 32 } 'An invalid secret was accepted.'
  }
  Assert ((Get-DriverRelease 'AMD64').Sha256 -eq '1e264492f7f4d69d5b7920c445dd637bef90e45a21a3a90de4fbe63fee0cb388') 'x64 digest changed.'
  Assert ((Get-DriverRelease 'ARM64').Url.EndsWith('windows-arm64-binary.zip')) 'ARM64 release mapping failed.'
  Assert-Throws { Get-DriverRelease 'x86' } 'Unsupported architecture was accepted.'

  # Synthetic archive tests never execute a binary or fetch any network URL.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Add-Type -AssemblyName System.IO.Compression
  $archive = Join-Path $testRoot 'fixture.zip'
  $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
  try {
    $entry = $zip.CreateEntry('nested/bin/cua-driver.exe')
    $writer = [IO.StreamWriter]::new($entry.Open())
    try { $writer.Write('INERT TEST FIXTURE - NEVER EXECUTE') } finally { $writer.Dispose() }
    $traversal = $zip.CreateEntry('../escape.txt')
    $writer = [IO.StreamWriter]::new($traversal.Open())
    try { $writer.Write('must not extract') } finally { $writer.Dispose() }
  } finally { $zip.Dispose() }
  $fixtureHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
  $extracted = Join-Path $testRoot 'checked.exe'
  Assert-Throws { Install-VerifiedDriver $archive ('0' * 64) $extracted } 'Bad checksum was accepted.'
  Assert (-not (Test-Path -LiteralPath $extracted)) 'A bad checksum produced an executable.'
  Install-VerifiedDriver $archive $fixtureHash $extracted
  Assert ([IO.File]::ReadAllText($extracted) -eq 'INERT TEST FIXTURE - NEVER EXECUTE') 'Verified executable extraction failed.'
  Assert (-not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $testRoot) 'escape.txt'))) 'Archive path traversal was expanded.'
  Assert-Throws { Install-VerifiedDriver $archive $fixtureHash $extracted } 'Extraction overwrote an existing executable.'

  # End-to-end preparation with inert dependency and download substitutes.
  # The real installed Node runs only version checks and an inert npm fixture.
  $fixtureRepo = Join-Path $testRoot ('repo-' + $unicodeText)
  New-Item -ItemType Directory -Path (Join-Path $fixtureRepo 'scripts') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot '.harness.local.example.psd1') -Destination $fixtureRepo
  Write-NewUtf8File (Join-Path $fixtureRepo 'scripts\mobile.ps1') 'param($Command) if ($Command -ne "check") { throw "Unexpected launch" }; Write-Output "Fixture configuration check."'
  $fakeNpx = Join-Path $testRoot 'npx.cmd'
  Write-NewUtf8File $fakeNpx "@echo off`r`nexit /b 99`r`n"
  $fakeNpxEntry = Join-Path $testRoot 'node_modules\npm\bin\npx-cli.js'
  New-Item -ItemType Directory -Path (Split-Path -Parent $fakeNpxEntry) -Force | Out-Null
  Write-NewUtf8File $fakeNpxEntry 'console.log("fixture npx " + process.argv.slice(2).join(" ")); console.log("fixture node " + process.execPath);'
  $script:hidePathNode = $false
  $script:promptValues = [Collections.Generic.Queue[string]]::new()
  $script:capturedPrompts = [Collections.Generic.List[string]]::new()
  foreach ($value in @('https://relay.example.com', 'fixture-host', ('secret_' + ('a' * 43)), 'fake_model_key_not_real')) { $script:promptValues.Enqueue($value) }
  function Read-Host {
    param([string] $Prompt, [switch] $AsSecureString)
    if ($script:promptValues.Count -eq 0) { throw 'Unexpected interactive prompt.' }
    $script:capturedPrompts.Add($Prompt)
    $value = $script:promptValues.Dequeue()
    if ($AsSecureString) { return ConvertTo-SecureString -String $value -AsPlainText -Force }
    return $value
  }
  function Get-Command {
    param([string] $Name, $CommandType, $ErrorAction)
    if ($Name -eq 'node.exe' -and $script:hidePathNode) { return $null }
    if ($Name -eq 'npx.cmd') { return [pscustomobject]@{ Source = $fakeNpx } }
    return Microsoft.PowerShell.Core\Get-Command -Name $Name -CommandType $CommandType -ErrorAction $ErrorAction
  }
  function Get-DriverRelease { param([string] $Architecture) return @{ Url = 'https://fixture.invalid/never-fetched.zip'; Sha256 = $fixtureHash } }
  function Invoke-WebRequest {
    param([string] $Uri, [string] $OutFile, [switch] $UseBasicParsing)
    Assert ($Uri -eq 'https://fixture.invalid/never-fetched.zip') 'Unexpected download URL.'
    [IO.File]::Copy($archive, $OutFile, $false)
  }
  $pathBeforeSetup = $env:PATH
  $output = (Invoke-MobileSetup $fixtureRepo | Out-String)
  Assert ($env:PATH -eq $pathBeforeSetup) 'Setup did not restore the process PATH.'
  Assert ($output -notmatch 'secret_aaaa|fake_model_key_not_real') 'A secret leaked into setup output.'
  Assert ($script:promptValues.Count -eq 0) 'Setup did not consume the expected prompts.'
  Assert ($script:capturedPrompts.Count -eq 4) 'Setup changed the four-prompt flow.'
  foreach ($prompt in $script:capturedPrompts) {
    Assert ($prompt -match '[\u4E00-\u9FFF]' -and $prompt -notmatch '\?{2,}|\uFFFD') 'A setup prompt was not intact Chinese.'
  }
  Assert ($output -match '[\u4E00-\u9FFF]' -and $output -notmatch '\?{2,}|\uFFFD') 'Chinese setup output was corrupted.'
  $config = Import-PowerShellDataFile -LiteralPath (Join-Path $fixtureRepo '.harness.local.psd1')
  Assert (Test-Path -LiteralPath $config.NodePath -PathType Leaf) 'Node executable was not detected.'
  Assert ($output -match [regex]::Escape("fixture node $($config.NodePath)")) 'Installation did not use the configured Node executable.'
  $writtenEnv = [IO.File]::ReadAllText((Join-Path $fixtureRepo '.env'), [Text.UTF8Encoding]::new($false, $true))
  Assert ($writtenEnv.Contains('HARNESS_RELAY_PUBLIC_ORIGIN=https://relay.example.com')) 'Relay public origin was not generated.'
  Assert ($writtenEnv.Contains('ZHIPUAI_API_KEY=fake_model_key_not_real')) 'Model key was not generated correctly.'
  $preserved = @{}
  foreach ($relative in @('.env', '.harness.local.psd1', '.tools\cua-driver\0.22.2\bin\cua-driver.exe')) {
    $preserved[$relative] = (Get-FileHash -LiteralPath (Join-Path $fixtureRepo $relative)).Hash
  }
  # A configured executable remains usable without a node.exe entry on PATH.
  $script:hidePathNode = $true
  Invoke-MobileSetup $fixtureRepo | Out-Null
  $freshRepo = Join-Path $testRoot 'fresh-without-path-node'
  New-Item -ItemType Directory -Path $freshRepo | Out-Null
  Assert-Throws { Invoke-MobileSetup $freshRepo } 'First setup without a configured or PATH Node should fail.'
  Assert (-not (Test-Path -LiteralPath (Join-Path $freshRepo '.harness.local.psd1'))) 'Failed Node discovery wrote a configuration.'
  $script:hidePathNode = $false
  foreach ($relative in $preserved.Keys) {
    Assert ((Get-FileHash -LiteralPath (Join-Path $fixtureRepo $relative)).Hash -eq $preserved[$relative]) 'Rerunning setup changed an existing private file or driver.'
  }
  $fallbackOutput = (Invoke-MobileSetup $fixtureRepo | Out-String)
  Assert ($fallbackOutput.Contains('fixture npx --yes pnpm@11.19.0 install --frozen-lockfile')) 'npx fallback did not pin pnpm or preserve the lockfile.'
  [IO.File]::WriteAllText($fakeNpxEntry, 'process.exit(17);', [Text.UTF8Encoding]::new($false))
  Assert-Throws { Invoke-MobileSetup $fixtureRepo } 'Dependency installation failure was ignored.'
  Assert ($env:PATH -eq $pathBeforeSetup) 'A failed install did not restore the process PATH.'
  Write-Output 'PASS: UTF-8 BOM/Chinese prompts, Chinese repository path, atomic failed-write cleanup/retry, no overwrite, origin/secret validation, release mapping, checksum rejection, safe extraction, offline setup, secret redaction, rerun preservation, pinned npx fallback, failed install/PATH restoration.'
} finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $expectedParent = [IO.Path]::GetFullPath((Join-Path $repoRoot '.cache')) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedTestRoot.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase) -or
      (Split-Path -Leaf $resolvedTestRoot) -notlike 'setup-mobile-test-*') { throw 'Refusing cleanup outside the test fixture directory.' }
  Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
