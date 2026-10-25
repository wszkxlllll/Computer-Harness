param(
  [Parameter(Mandatory = $true)][string]$StatePath,
  [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ExpectedText,
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
  throw "fixture state file does not exist: $StatePath"
}

$escapedText = $null
foreach ($line in Get-Content -LiteralPath $StatePath -Encoding UTF8) {
  if ($line -match '^text=(.*)$') {
    $escapedText = $Matches[1]
    break
  }
}

if ($null -eq $escapedText) {
  throw "fixture state does not contain an exact text field"
}

function Decode-ProbeText([string]$value) {
  $builder = [System.Text.StringBuilder]::new()
  $index = 0
  while ($index -lt $value.Length) {
    $consumedEscape = $false
    if ($value[$index] -eq '\' -and $index + 1 -lt $value.Length) {
      $next = $value[$index + 1]
      if ($next -eq 'n') {
        [void]$builder.Append([char]10)
        $index += 2
        $consumedEscape = $true
      } elseif ($next -eq 'r') {
        [void]$builder.Append([char]13)
        $index += 2
        $consumedEscape = $true
      } elseif ($next -eq '\') {
        [void]$builder.Append('\')
        $index += 2
        $consumedEscape = $true
      }
    }
    if (-not $consumedEscape) {
      [void]$builder.Append($value[$index])
      $index += 1
    }
  }
  $builder.ToString()
}

# ProbeWindow escapes only characters that would make the line ambiguous.
$actualText = Decode-ProbeText $escapedText
$success = $actualText -ceq $ExpectedText
$result = [ordered]@{
  status = "evaluated"
  success = $success
  reason = if ($success) { "fixture text exactly matches expected text" } else { "fixture text does not exactly match expected text" }
  expectedTextLength = $ExpectedText.Length
  actualTextLength = $actualText.Length
}
$json = $result | ConvertTo-Json -Depth 4
if ($OutputPath) {
  $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($OutputPath))
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8
}
$json
