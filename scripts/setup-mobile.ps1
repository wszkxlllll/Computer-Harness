[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Write-FileBytes([string] $Path, [byte[]] $Bytes) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
}

function Write-NewUtf8File([string] $Path, [string] $Content, [switch] $WithBom) {
  if (Test-Path -LiteralPath $Path) { throw "Existing file will not be overwritten: $Path" }
  $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Content)
  if ($WithBom) { $bytes = [Text.UTF8Encoding]::new($true).GetPreamble() + $bytes }
  # .env.* is already ignored, including leftovers after a process interruption.
  $stage = Join-Path (Split-Path -Parent $Path) ('.env.setup-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    Write-FileBytes $stage $bytes
    if ([IO.File]::ReadAllText($stage, [Text.UTF8Encoding]::new($false, $true)) -cne $Content) {
      throw 'UTF-8 verification failed after writing the local file.'
    }
    # Same-directory move publishes only a complete file and refuses collisions.
    [IO.File]::Move($stage, $Path)
  } finally {
    if (Test-Path -LiteralPath $stage -PathType Leaf) { Remove-Item -LiteralPath $stage -Force }
  }
}

function Read-PrivateValue([string] $Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}

function Assert-EnvValue([string] $Value, [string] $Label, [int] $MinimumLength = 1) {
  # Match the Host's line-based env reader without altering a supplied secret.
  if ($Value.Length -lt $MinimumLength -or $Value.Length -gt 4096 -or
      $Value -match '[\r\n\x00]' -or $Value -ne $Value.Trim() -or
      $Value.StartsWith("'") -or $Value.StartsWith('"') -or
      $Value.EndsWith("'") -or $Value.EndsWith('"')) {
    throw "$Label is empty or cannot be stored safely in the Host env file."
  }
}

function Get-RelayOrigin([string] $Value) {
  $uri = $null
  if (-not [Uri]::TryCreate($Value.Trim(), [UriKind]::Absolute, [ref] $uri) -or
      $uri.Scheme -ne 'https' -or $uri.UserInfo -ne '' -or
      $uri.AbsolutePath -ne '/' -or $uri.Query -ne '' -or $uri.Fragment -ne '' -or
      $uri.IsLoopback) {
    throw 'Relay URL must be the public HTTPS origin from your administrator, for example https://relay.example.com (no path or query).'
  }
  return $uri.GetLeftPart([UriPartial]::Authority)
}

function Get-DriverRelease([string] $Architecture) {
  # Official release: https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.22.2
  # Keep the daemon paired with the workspace's 0.22.2 native SDK.
  $hashes = @{
    AMD64 = '1e264492f7f4d69d5b7920c445dd637bef90e45a21a3a90de4fbe63fee0cb388'
    ARM64 = '8ec1526ea39a671a2a3f3fdcedccd2bdab0f83dbc1c8da9b9fff77cbe4e39d3c'
  }
  if (-not $hashes.ContainsKey($Architecture)) { throw 'This setup supports Windows x64 and ARM64 only.' }
  $assetArchitecture = if ($Architecture -eq 'AMD64') { 'x86_64' } else { 'arm64' }
  return @{
    Url = "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.22.2/cua-driver-rs-0.22.2-windows-$assetArchitecture-binary.zip"
    Sha256 = $hashes[$Architecture]
  }
}

function Install-VerifiedDriver([string] $Archive, [string] $ExpectedHash, [string] $Destination) {
  if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $ExpectedHash) {
    throw '驱动下载校验失败，未安装或执行下载内容。请检查网络后重新运行准备命令。'
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $entries = @($zip.Entries | Where-Object { $_.Name -eq 'cua-driver.exe' })
    if ($entries.Count -ne 1) { throw 'The verified CUA archive must contain exactly one cua-driver.exe.' }
    # Copy just the expected executable; never expand archive-supplied paths.
    $source = $entries[0].Open()
    try {
      $target = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $source.CopyTo($target) } finally { $target.Dispose() }
    } finally { $source.Dispose() }
  } finally { $zip.Dispose() }
}

function Invoke-MobileSetup([string] $RepoRoot) {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw '这个准备程序适用于 Windows。' }
  $configPath = Join-Path $RepoRoot '.harness.local.psd1'
  if (Test-Path -LiteralPath $configPath) {
    $config = Import-PowerShellDataFile -LiteralPath $configPath
    Write-Output '已保留原来的电脑配置（.harness.local.psd1）。'
  } else {
    $nodePath = $null
    foreach ($candidate in @(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
      $nodeVersion = (& $candidate.Source -p 'process.versions.node').Trim()
      if ($LASTEXITCODE -eq 0 -and [version] $nodeVersion -ge [version] '22.13.0') { $nodePath = $candidate.Source; break }
    }
    if ($null -eq $nodePath) {
      throw '需要 Node.js 22.13.0 或更高版本。请从 https://nodejs.org/en/download 安装 Node.js 24 LTS，重新打开 PowerShell 后再运行准备命令。'
    }
    $template = [IO.File]::ReadAllText((Join-Path $RepoRoot '.harness.local.example.psd1'), [Text.Encoding]::UTF8)
    $template = $template.Replace("NodePath = 'C:\path\to\node.exe'", "NodePath = '$($nodePath.Replace("'", "''"))'")
    # Windows PowerShell 5.1 needs the BOM to read non-ASCII machine paths.
    Write-NewUtf8File $configPath $template -WithBom
    $config = Import-PowerShellDataFile -LiteralPath $configPath
    Write-Output '已自动找到 Node.js，并生成电脑配置。'
  }
  foreach ($name in @('NodePath', 'EnvFile', 'CuaBinary', 'CuaSocket', 'Model', 'OutputRoot')) {
    if ([string]::IsNullOrWhiteSpace([string] $config[$name])) {
      throw "Existing .harness.local.psd1 is missing $name. Add this entry from .harness.local.example.psd1; existing settings were not overwritten."
    }
  }
  if ($config.Model -notin @('glm-5.3-flash', 'qwen3.8-flash')) {
    throw 'The mobile launcher supports glm-5.3-flash and qwen3.8-flash. Existing settings were not overwritten.'
  }
  $configuredNode = if ([IO.Path]::IsPathRooted($config.NodePath)) { $config.NodePath } else { Join-Path $RepoRoot $config.NodePath }
  if (-not (Test-Path -LiteralPath $configuredNode -PathType Leaf)) {
    throw 'The NodePath in your existing .harness.local.psd1 does not exist. Update it to your installed node.exe; setup preserved the file.'
  }
  $configuredVersion = (& $configuredNode -p 'process.versions.node').Trim()
  if ($LASTEXITCODE -ne 0 -or [version] $configuredVersion -lt [version] '22.13.0') {
    throw 'NodePath in your existing configuration must point to Node.js >=22.13.0. Existing settings were not overwritten.'
  }
  $envPath = if ([IO.Path]::IsPathRooted($config.EnvFile)) { $config.EnvFile } else { Join-Path $RepoRoot $config.EnvFile }
  if (Test-Path -LiteralPath $envPath) {
    Write-Output '已保留原来的密钥文件。若还没填写连接资料，请查看入门指南中的“已有配置怎么填写”。'
  } else {
    $apiKeyName = switch ($config.Model) {
      'glm-5.3-flash' { 'ZHIPUAI_API_KEY' }
      'qwen3.8-flash' { 'DASHSCOPE_API_KEY' }
      default { throw 'The configured model is not supported by this setup.' }
    }
    Write-Output '请填写管理员提供的三项连接资料，再填写你的模型密钥。密钥输入时不会显示。'
    $relayOrigin = Get-RelayOrigin (Read-Host 'Relay 地址（HTTPS）')
    $hostId = (Read-Host '电脑编号（Host ID）').Trim()
    if ($hostId -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw 'Host ID must contain 1-128 letters, digits, underscores or hyphens.' }
    $credential = Read-PrivateValue '连接凭据'
    Assert-EnvValue $credential 'Relay credential' 32
    if ($credential.Contains('REPLACE')) { throw 'Use your actual Relay credential, not a template placeholder.' }
    $modelLabel = if ($config.Model -eq 'glm-5.3-flash') { 'GLM' } else { 'Qwen' }
    $apiKey = Read-PrivateValue "模型密钥（$modelLabel）"
    Assert-EnvValue $apiKey 'Model API key'
    $envContent = "$apiKeyName=$apiKey`nHARNESS_RELAY_URL=$relayOrigin`nHARNESS_HOST_ID=$hostId`nHARNESS_RELAY_CREDENTIAL=$credential`nHARNESS_RELAY_PUBLIC_ORIGIN=$relayOrigin`n"
    Write-NewUtf8File $envPath $envContent
    $apiKey = $null; $credential = $null; $envContent = $null
    Write-Output '连接资料和模型密钥已保存在本机私有文件中。请勿分享该文件或将它加入 Git。'
  }

  $driverPath = if ([IO.Path]::IsPathRooted($config.CuaBinary)) { $config.CuaBinary } else { Join-Path $RepoRoot $config.CuaBinary }
  if (Test-Path -LiteralPath $driverPath -PathType Leaf) {
    Write-Output '已保留原来的电脑控制驱动，本次没有重新校验它的来源。'
  } else {
    $standardPath = [IO.Path]::GetFullPath((Join-Path $RepoRoot '.tools\cua-driver\0.22.2\bin\cua-driver.exe'))
    if ([IO.Path]::GetFullPath($driverPath) -ne $standardPath) {
      throw 'Your configured CuaBinary is missing. Restore that executable, or use the standard CuaBinary path from .harness.local.example.psd1.'
    }
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $release = Get-DriverRelease $architecture
    $driverDirectory = Split-Path -Parent $driverPath
    New-Item -ItemType Directory -Force -Path $driverDirectory | Out-Null
    $download = Join-Path $driverDirectory ('download-' + [Guid]::NewGuid().ToString('N') + '.zip')
    $stagedDriver = Join-Path $driverDirectory ('verified-' + [Guid]::NewGuid().ToString('N') + '.exe')
    try {
      Write-Output '正在下载官方电脑控制驱动（CUA 0.22.2），并校验文件完整性……'
      Invoke-WebRequest -Uri $release.Url -OutFile $download -UseBasicParsing
      Install-VerifiedDriver $download $release.Sha256 $stagedDriver
      [IO.File]::Move($stagedDriver, $driverPath)
    } finally {
      foreach ($temporaryFile in @($download, $stagedDriver)) {
        if (Test-Path -LiteralPath $temporaryFile -PathType Leaf) { Remove-Item -LiteralPath $temporaryFile -Force }
      }
    }
  }

  $previousPath = $env:PATH
  Push-Location $RepoRoot
  try {
    # Only this process and its children use the selected Node; restore on exit.
    $env:PATH = (Split-Path -Parent $configuredNode) + [IO.Path]::PathSeparator + $previousPath
    Write-Output '正在安装项目需要的依赖，请稍候……'
    $npx = Get-Command npx.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $npx) { throw '找不到 npx.cmd。请修复 Node.js 安装，重新打开 PowerShell 后再运行准备命令。' }
    $npxEntry = Join-Path (Split-Path -Parent $npx.Source) 'node_modules\npm\bin\npx-cli.js'
    if (-not (Test-Path -LiteralPath $npxEntry -PathType Leaf)) { throw '找不到 npm 的运行文件。请安装完整的 Node.js 后重试。' }
    # npx.cmd can force its sibling (older) node.exe despite our PATH. Run the
    # CLI with the validated executable so installation and startup agree.
    & $configuredNode $npxEntry --yes pnpm@11.19.0 install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。请检查上面的网络或下载错误，处理后重新运行准备命令。' }
    & (Join-Path $RepoRoot 'scripts\mobile.ps1') -Command check
  } finally { $env:PATH = $previousPath; Pop-Location }
  Write-Output '准备完成。请复制运行下面的命令，启动电脑端：'
  Write-Output 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\mobile.ps1 -Command start -Build'
  Write-Output '启动后，在这台电脑的浏览器打开 http://localhost:4317/connect，生成二维码让手机扫码。'
}

Invoke-MobileSetup ([IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)))
