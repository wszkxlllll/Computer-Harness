param(
  [string]$Output = "runs/api-conformance/non-sensitive-ui.png"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$resolved = [System.IO.Path]::GetFullPath($Output)
$parent = [System.IO.Path]::GetDirectoryName($resolved)
if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }

$bitmap = New-Object System.Drawing.Bitmap 640, 360
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.Clear([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font "Segoe UI", 24
  $smallFont = New-Object System.Drawing.Font "Segoe UI", 14
  $graphics.DrawString("Synthetic UI", $font, [System.Drawing.Brushes]::Black, 40, 40)
  $graphics.DrawString("Click the blue button", $smallFont, [System.Drawing.Brushes]::Black, 40, 100)
  $graphics.FillRectangle([System.Drawing.Brushes]::RoyalBlue, 40, 170, 240, 70)
  $graphics.DrawString("CLICK", $font, [System.Drawing.Brushes]::White, 105, 185)
  $bitmap.Save($resolved, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
Write-Output $resolved
