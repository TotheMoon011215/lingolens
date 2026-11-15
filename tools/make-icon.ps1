# 生成多尺寸 icon.ico（16/32/48/64/128/256），供快捷方式与任务栏使用。
# 用法：powershell -File tools\make-icon.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'assets\icon.ico'

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [Math]::Max(1, [int]($size * 0.03))
  $r = [int]($size * 0.22)
  $rect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - $pad * 2), ($size - $pad * 2)

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($rect.X, $rect.Y, $r * 2, $r * 2, 180, 90)
  $path.AddArc($rect.Right - $r * 2, $rect.Y, $r * 2, $r * 2, 270, 90)
  $path.AddArc($rect.Right - $r * 2, $rect.Bottom - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()

  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 20, 22, 25))
  $g.FillPath($bg, $path)
  $penW = [Math]::Max(1.0, $size * 0.035)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 124, 147, 238)), $penW
  $g.DrawPath($pen, $path)

  $fontSize = $size * 0.56
  $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $box = New-Object System.Drawing.RectangleF 0, ($size * 0.02), $size, $size
  $g.DrawString('L', $font, $white, $box, $fmt)

  $g.Dispose()
  return $bmp
}

$sizes = 16, 32, 48, 64, 128, 256
$pngs = New-Object System.Collections.ArrayList

$master = New-IconBitmap 256
foreach ($s in $sizes) {
  $b = New-Object System.Drawing.Bitmap $master, $s, $s
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  [void]$pngs.Add($ms.ToArray())
  $b.Dispose()
  $ms.Dispose()
}
$master.Dispose()

$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0)            # reserved
$bw.Write([UInt16]1)            # type = icon
$bw.Write([UInt16]$sizes.Count) # count

$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $data = $pngs[$i]
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write([Byte]0)   # colors
  $bw.Write([Byte]0)   # reserved
  $bw.Write([UInt16]1) # planes
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length)
  $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($d in $pngs) { $bw.Write($d) }
$bw.Flush(); $bw.Close(); $fs.Close()

$fi = Get-Item $out
"icon.ico: {0:N1} KB  ({1} sizes)" -f ($fi.Length / 1KB), $sizes.Count
