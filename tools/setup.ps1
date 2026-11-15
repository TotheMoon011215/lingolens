# 一次性准备：下载词库、下载 OCR 模型、编译原生桥。
# 前提：已执行 pnpm install（需要 node_modules 里的 electron / tesseract.js）
# 用法：powershell -ExecutionPolicy Bypass -File tools\setup.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw '找不到 node，请先安装 Node.js 18+ 并加入 PATH' }

Write-Host '==> 1/3 下载 ECDICT 词库（约 22MB）'
$tgz = Join-Path $root 'data\ecdict.tgz'
& $node (Join-Path $root 'tools\fetch.js') `
  'https://registry.npmmirror.com/ecdict/-/ecdict-0.0.4.tgz' $tgz 8
if ($LASTEXITCODE -ne 0) { throw '词库下载失败' }

Write-Host '==> 2/3 生成 dict.bin'
$pkg = Join-Path $root 'data\pkg'
if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pkg | Out-Null
tar.exe -xzf $tgz -C $pkg
& $node (Join-Path $root 'core\dict-build.js') `
  (Join-Path $pkg 'package\assets\ecdict.csv') (Join-Path $root 'data\dict.bin')
if ($LASTEXITCODE -ne 0) { throw '词库构建失败' }
Remove-Item $tgz, $pkg -Recurse -Force

Write-Host '==> 3/3 下载英文 OCR 模型（2.8MB）并编译原生桥'
$ocr = Join-Path $root 'data\tessdata'
New-Item -ItemType Directory -Force -Path $ocr | Out-Null
$ocrTgz = Join-Path $root 'data\eng.tgz'
& $node (Join-Path $root 'tools\fetch.js') `
  'https://registry.npmmirror.com/@tesseract.js-data/eng/-/eng-1.0.0.tgz' $ocrTgz 8
$tmp = Join-Path $root 'data\tesspkg'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
tar.exe -xzf $ocrTgz -C $tmp
Copy-Item (Join-Path $tmp 'package\4.0.0_best_int\eng.traineddata.gz') `
  (Join-Path $ocr 'eng.traineddata.gz') -Force
Remove-Item $ocrTgz, $tmp -Recurse -Force

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$wpf = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
if (Test-Path $csc) {
  & $csc /nologo /target:exe /platform:anycpu `
    "/out:$root\native\NativeBridge.exe" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll `
    "/r:$wpf\UIAutomationClient.dll" "/r:$wpf\UIAutomationTypes.dll" "/r:$wpf\WindowsBase.dll" `
    "$root\native\NativeBridge.cs"
  if ($LASTEXITCODE -ne 0) { throw 'NativeBridge 编译失败' }
} else {
  Write-Warning '找不到 csc.exe（.NET Framework 4.x），跳过原生桥编译，划词/截图功能将不可用'
}

Write-Host ''
Write-Host '完成。下一步：'
Write-Host '  Copy-Item config.example.json config.json   # 然后填入 API Key'
Write-Host '  LingoLens.vbs'
