param(
  [string]$Model = 'gui-plus-2026-02-26',
  [string]$Proxy = 'http://127.0.0.1:7892'
)

$ErrorActionPreference = 'Stop'

function Read-DotEnv([string]$Path) {
  $result = @{}
  foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $name = $Matches[1]
      $value = $Matches[2].Trim()
      if (($value.StartsWith("'") -and $value.EndsWith("'")) -or
          ($value.StartsWith('"') -and $value.EndsWith('"'))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $result[$name] = $value
    }
  }
  return $result
}

$envValues = Read-DotEnv (Join-Path (Get-Location) '.env')
$apiKey = $envValues['DASHSCOPE_API_KEY']
$workspaceId = $envValues['DASHSCOPE_WORKSPACE_ID']
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw 'DASHSCOPE_API_KEY is missing' }
if ([string]::IsNullOrWhiteSpace($workspaceId)) { throw 'DASHSCOPE_WORKSPACE_ID is missing' }

# Synthetic UI: no real screenshot and no computer-side effect.
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(640, 360)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::White)
$graphics.FillRectangle([System.Drawing.Brushes]::DodgerBlue, 500, 140, 100, 50)
$graphics.Dispose()
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$imageData = [Convert]::ToBase64String($stream.ToArray())

$request = @{
  model = $Model
  messages = @(
    @{
      role = 'user'
      content = @(
        @{ type = 'text'; text = 'Describe the synthetic UI in one short sentence and mention the blue button.' }
        @{ type = 'image_url'; image_url = @{ url = 'data:image/png;base64,' + $imageData } }
      )
    }
  )
  max_tokens = 128
  temperature = 0
} | ConvertTo-Json -Depth 12 -Compress

$endpoint = 'https://' + $workspaceId + '.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions'
$headers = @{ Authorization = 'Bearer ' + $apiKey }

try {
  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object System.Net.Http.HttpClientHandler
  if ($Proxy) {
    $handler.Proxy = New-Object System.Net.WebProxy($Proxy)
    $handler.UseProxy = $true
  }
  $client = New-Object System.Net.Http.HttpClient($handler)
  $httpRequest = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $endpoint)
  $httpRequest.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $apiKey)
  $httpRequest.Content = New-Object System.Net.Http.StringContent($request, [Text.Encoding]::UTF8, 'application/json')
  $httpResponse = $client.SendAsync($httpRequest).GetAwaiter().GetResult()
  $responseBody = $httpResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  if (-not $httpResponse.IsSuccessStatusCode) {
    $errorCode = $null
    $errorMessage = $null
    try {
      $errorJson = $responseBody | ConvertFrom-Json
      if ($errorJson.error) { $errorJson = $errorJson.error }
      $errorCode = $errorJson.code
      $errorMessage = $errorJson.message
    } catch {}
    if (-not $errorMessage) { $errorMessage = $responseBody.Substring(0, [Math]::Min(300, $responseBody.Length)) }
    [pscustomobject]@{
      ok = $false
      http_status = [int]$httpResponse.StatusCode
      error_code = $errorCode
      error_message = $errorMessage
    } | ConvertTo-Json -Compress
    return
  }
  $response = $responseBody | ConvertFrom-Json
  $content = [string]$response.choices[0].message.content
  $prefix = $content
  if ($prefix.Length -gt 300) { $prefix = $prefix.Substring(0, 300) }
  [pscustomobject]@{
    ok = $true
    http_status = 200
    model = $response.model
    finish_reason = $response.choices[0].finish_reason
    content_chars = $content.Length
    content_prefix = $prefix
  } | ConvertTo-Json -Compress
}
catch {
  $status = $null
  $code = $null
  $message = $_.Exception.Message
  if ($message -match '^HTTP (\d+):\s*([^:]+):\s*(.*)$') {
    $status = [int]$Matches[1]
    $code = $Matches[2]
    $message = $Matches[3]
  }
  $errorDetails = $_.ErrorDetails.Message
  if ($_.Exception.Response) {
    try { $status = [int]$_.Exception.Response.StatusCode } catch {}
    try {
      $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      $errorBody = $reader.ReadToEnd()
      $errorJson = $errorBody | ConvertFrom-Json
      if ($errorJson.error) { $errorJson = $errorJson.error }
      if ($errorJson.code) { $code = $errorJson.code }
      if ($errorJson.message) { $message = $errorJson.message }
    } catch {}
  }
  if ($errorDetails) {
    try {
      $errorJson = $errorDetails | ConvertFrom-Json
      if ($errorJson.error) { $errorJson = $errorJson.error }
      if ($errorJson.code) { $code = $errorJson.code }
      if ($errorJson.message) { $message = $errorJson.message }
    } catch {}
  }
  [pscustomobject]@{
    ok = $false
    http_status = $status
    error_code = $code
    error_message = $message
  } | ConvertTo-Json -Compress
}
