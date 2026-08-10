# build_frontend.ps1
# 前端"编译"：对 index.html 做安全压缩（逐行裁剪 + 去 HTML 注释，
# 不跨行合并，因而不会破坏内联 <script>/<style> 的 JS/CSS 语义），
# 并将静态资源与说明文档同步到 dist/ 供 server.py 托管。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ConfigPath = Join-Path $ScriptDir 'config.json'
if (-not (Test-Path $ConfigPath)) {
    Write-Host "未找到 config.json：$ConfigPath" -ForegroundColor Red
    exit 2
}
$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

$fe      = $cfg.frontend
$root    = Split-Path -Parent $ScriptDir   # 项目根目录（script/ 的上级），源码与 dist 均在此
$srcDir  = Join-Path $root $fe.source_dir
$distDir = Join-Path $root $fe.dist_dir

function Write-Step($n, $msg) { Write-Host ("[步骤 {0}] {1}" -f $n, $msg) -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host ("  [OK]   {0}" -f $msg) -ForegroundColor Green }
function Write-Warn($m)   { Write-Host ("  [提示] {0}" -f $m) -ForegroundColor Yellow }

Write-Host "====== 前端编译 CodexQQSkin ======" -ForegroundColor Yellow

# ---- 1) 准备 dist 目录 ----
Write-Step 1 "准备输出目录 $distDir"
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
Write-Ok "目录就绪"

# ---- 2) 安全压缩 index.html ----
Write-Step 2 "处理 index.html"
$htmlSrc = Join-Path $srcDir $fe.minify_target
if (-not (Test-Path $htmlSrc)) {
    Write-Host "未找到前端入口：$htmlSrc" -ForegroundColor Red; exit 3
}
$htmlDst = Join-Path $distDir $fe.minify_target

if ($fe.minify) {
    $protect = $fe.protect_tags -join '|'
    $openRe  = [regex]("<\s*($protect)[ >]")
    $closeRe = [regex]("</\s*($protect)\s*>")
    $commentRe = [regex]('<!--.*?-->')

    $lines = [System.IO.File]::ReadAllLines($htmlSrc, [System.Text.Encoding]::UTF8)
    $out = New-Object System.Collections.Generic.List[string]
    $inProtect = $false
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if (-not $inProtect -and $openRe.IsMatch($trim)) { $inProtect = $true }
        if (-not $inProtect) {
            # 去除单行 HTML 注释
            $trim = $commentRe.Replace($trim, '')
            if ($trim -eq '') { continue }   # 丢弃纯空白行
        }
        $out.Add($trim)
        if ($closeRe.IsMatch($trim)) { $inProtect = $false }
    }
    $content = $out -join "`r`n"
    [System.IO.File]::WriteAllText($htmlDst, $content, [System.Text.UTF8Encoding]::new($false))
    $srcSize = (Get-Item $htmlSrc).Length
    $dstSize = (Get-Item $htmlDst).Length
    $pct = if ($srcSize -gt 0) { [math]::Round((1 - $dstSize / $srcSize) * 100, 1) } else { 0 }
    Write-Ok ("已压缩 $($fe.minify_target)：$([math]::Round($srcSize/1KB,1)) KB -> $([math]::Round($dstSize/1KB,1)) KB（节省 ${pct}%）")
} else {
    Copy-Item -Path $htmlSrc -Destination $htmlDst -Force
    Write-Ok "已原样复制 $($fe.minify_target)（minify 关闭）"
}

# ---- 3) 复制其余静态资源 ----
Write-Step 3 "复制静态资源与文档到 dist/"
foreach ($asset in $fe.assets) {
    if ($asset -eq $fe.minify_target) { continue }  # 已在步骤 2 处理
    $src = Join-Path $srcDir $asset
    if (-not (Test-Path $src)) { Write-Warn ("资源缺失，跳过：$asset"); continue }
    if ($asset -eq 'assets') {
        # 从源头递归复制并跳过 _*.test.mjs。
        # 坑：Join-Path 产生的 $src 可能带尾部 "\."（如 "root\."），而 Get-ChildItem
        # 返回的 $_.FullName 是规范化路径（无 "\."），直接 Substring($src.Length)
        # 会算错相对路径，把文件拷到错误嵌套位置（如 dist/assets/ss/app.css 而非
        # dist/assets/css/app.css），导致正路径文件漏更新。故先 Get-Item 取规范化
        # FullName 作基准；并用 .NET File.Copy(...,$true) 强制覆盖（规避 PowerShell
        # Copy-Item 在本沙箱下对“已存在文件”偶发静默不覆盖的问题）。
        $dst = Join-Path $distDir $asset
        if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst | Out-Null }
        $srcRoot = (Get-Item $src).FullName
        Get-ChildItem -Path $srcRoot -Recurse -File |
            Where-Object { $_.Name -notmatch '^_.*\.test\.mjs$' } |
            ForEach-Object {
                $rel = $_.FullName.Substring($srcRoot.Length).TrimStart('\')
                $target = Join-Path $dst $rel
                $tdir = Split-Path -Parent $target
                if (-not (Test-Path $tdir)) { New-Item -ItemType Directory -Path $tdir | Out-Null }
                [System.IO.File]::Copy($_.FullName, $target, $true)
            }
        Write-Ok ("已复制 $asset（已排除 _*.test.mjs，规范化路径 + 强制覆盖）")
    } else {
        Copy-Item -Path $src -Destination (Join-Path $distDir $asset) -Force
        Write-Ok ("已复制 $asset")
    }
}

# ---- 3.5) 校验 dist/assets 不含开发测试文件（不删除，删除被 safe-delete 拦截） ----
Write-Step 3.5 "校验 dist/assets 不含 _*.test.mjs"
$left = Get-ChildItem -Path (Join-Path $distDir 'assets') -Recurse -Filter '_*.test.mjs' -ErrorAction SilentlyContinue
if ($left.Count -gt 0) {
    Write-Warn ("dist/assets 仍有 $($left.Count) 个历史残留测试文件（safe-delete 禁止删除，请用 rename 清理，本次不阻断）")
} else {
    Write-Ok "dist/assets 无测试文件"
}

# ---- 4) 校验 ----
Write-Step 4 "校验 dist 前端产物"
$checks = @($fe.minify_target, 'xiaoya.png')
$missing = @()
foreach ($c in $checks) {
    if (-not (Test-Path (Join-Path $distDir $c))) { $missing += $c }
}
if ($missing.Count -gt 0) {
    Write-Host ("缺失关键前端文件：$($missing -join ', ')") -ForegroundColor Red
    exit 4
}
Write-Ok "前端产物齐全（index.html + xiaoya.png 等）"

Write-Host "====== 前端编译完成 ======" -ForegroundColor Green
Write-Host ("dist 目录可直接由 server.py / CodexQQSkin.exe 托管") -ForegroundColor Cyan
exit 0
