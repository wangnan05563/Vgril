$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root      = Split-Path -Parent $ScriptDir

function Write-Step($n, $m) { Write-Host ("[STEP " + $n + "] " + $m) -ForegroundColor Cyan }
function Write-Ok($m)      { Write-Host ("  [OK] " + $m) -ForegroundColor Green }
function Write-Warn($m)    { Write-Host ("  [!]  " + $m) -ForegroundColor Yellow }

Write-Step 1 "读取 config.json"
$cfgPath = Join-Path $ScriptDir 'config.json'
if (-not (Test-Path $cfgPath)) { throw ("找不到 config.json: " + $cfgPath) }
$cfg  = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$rel  = $cfg.release
$source = Join-Path $root $rel.source_dir
$output = Join-Path $root $rel.output
$exclude = @($rel.exclude)
Write-Ok ("源目录 : " + $source)
Write-Ok ("输出   : " + $output)
Write-Ok ("排除   : " + ($exclude -join ', '))

Write-Step 2 "校验源目录与可执行文件"
if (-not (Test-Path $source)) {
  throw ("源目录不存在: " + $source + " （请先运行 build_package / build_frontend）")
}
$exePath = Join-Path $source $cfg.build.exe_name
if (-not (Test-Path $exePath)) {
  throw ("未找到可执行文件: " + $exePath + " （请先运行 build_package）")
}
Write-Ok ("可执行文件就绪: " + $cfg.build.exe_name)

Write-Step 3 "复制到临时暂存区并剔除密钥/运行时配置"
$stage = Join-Path $env:TEMP ('CodexQQSkin_stage_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  Copy-Item -Path (Join-Path $source '*') -Destination $stage -Recurse -Force
  foreach ($ex in $exclude) {
    $t = Join-Path $stage $ex
    if (Test-Path $t) { Remove-Item $t -Force }
  }
  $staged = Get-ChildItem $stage -File
  Write-Ok ("暂存文件数: " + $staged.Count)
  foreach ($f in $staged) { Write-Host ("    - " + $f.Name) }
  $leak = $staged | Where-Object { $exclude -contains $_.Name }
  if ($leak) { throw ("安全校验失败：排除文件仍被打包 -> " + ($leak.Name -join ', ')) }
  Write-Ok "安全校验通过：密钥/运行时配置未进入暂存区"
}
catch {
  Remove-Item -Path $stage -Recurse -Force -ErrorAction SilentlyContinue
  throw $_
}

Write-Step 4 "压缩为发布包"
$tempZip = Join-Path $env:TEMP ('CodexQQSkin_release_' + [guid]::NewGuid().ToString('N') + '.zip')
if (Test-Path $tempZip) { Remove-Item $tempZip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $tempZip -Force
Remove-Item -Path $stage -Recurse -Force -ErrorAction SilentlyContinue
Move-Item -Path $tempZip -Destination $output -Force
Write-Ok ("已生成: " + $output)

Write-Step 5 "校验发布包完整性"
if (-not (Test-Path $output)) { throw "发布包未生成" }
$zipSize = (Get-Item $output).Length
Write-Ok ("发布包大小: " + $zipSize.ToString('N0') + " 字节")

Write-Host ""
Write-Host "[DONE] 发布包构建完成" -ForegroundColor Green
exit 0
