# build_package.ps1
# 将 server.py 用 PyInstaller 打包为单文件 CodexQQSkin.exe，并内联前端静态资源。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ConfigPath = Join-Path $ScriptDir 'config.json'
if (-not (Test-Path $ConfigPath)) {
    Write-Host "未找到 config.json：$ConfigPath" -ForegroundColor Red
    exit 2
}
$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

$build   = $cfg.build
$rt      = $cfg.runtime
$root    = Split-Path -Parent $ScriptDir   # 项目根目录（script/ 的上级），dist/build/server.py 等均在此
$distDir = Join-Path $root $build.dist_dir
$workDir = Join-Path $root $build.work_dir
$specDir = Join-Path $root $build.spec_dir
$entry   = Join-Path $root $build.entry
$minVer  = $rt.python_min_version

function Write-Step($n, $msg) { Write-Host ("[步骤 {0}] {1}" -f $n, $msg) -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host ("  [OK]   {0}" -f $msg) -ForegroundColor Green }
function Write-Warn($m)   { Write-Host ("  [提示] {0}" -f $m) -ForegroundColor Yellow }
function Test-PyVer($py) {
    try {
        $v = & $py -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
        if ($v -match '^(\d+)\.(\d+)$') {
            $maj = [int]$Matches[1]; $min = [int]$Matches[2]
            return ($maj, $min, "$maj.$min")
        }
    } catch {}
    return $null
}
function Test-HasPyInstaller($py) {
    # PyInstaller 的可导入模块名为 PyInstaller（首字母大写）；
    # 仅 pyinstaller 控制台脚本存在，python -m pyinstaller 会报 "No module named pyinstaller"。
    foreach ($mod in @('PyInstaller', 'pyinstaller')) {
        try {
            $ver = & $py -m $mod --version 2>$null
            if ($ver -match '\d') { return $ver.Trim() }
        } catch {}
    }
    return $null
}

Write-Host "====== 打包构建 CodexQQSkin.exe ======" -ForegroundColor Yellow

# ---- 1) 定位 Python 解释器 ----
Write-Step 1 "定位 Python 解释器（多路径 fallback）"
$py = $null; $pyVer = $null; $pyiVer = $null
foreach ($cand in $rt.python_candidates) {
    $resolved = $null
    if (Test-Path $cand) { $resolved = $cand }
    else {
        try { $resolved = (Get-Command $cand -ErrorAction SilentlyContinue).Source } catch {}
    }
    if (-not $resolved) { continue }
    $info = Test-PyVer $resolved
    if (-not $info) { Write-Warn ("$resolved 无法获取版本，跳过"); continue }
    $maj, $min, $verStr = $info
    if (($maj -lt $minVer[0]) -or ($maj -eq $minVer[0] -and $min -lt $minVer[1])) {
        Write-Warn ("$resolved 版本 $verStr 低于要求 {0}.{1}，跳过" -f $minVer[0], $minVer[1]); continue
    }
    $pvi = Test-HasPyInstaller $resolved
    if ($rt.prefer_pyinstaller_present -and -not $pvi) {
        Write-Warn ("$resolved (v$verStr) 未安装 PyInstaller，跳过（优先选择已装 PyInstaller 的解释器）"); continue
    }
    $py = $resolved; $pyVer = $verStr; $pyiVer = $pvi
    break
}
if (-not $py) {
    Write-Host "未找到满足条件的 Python（需 >= {0}.{1} 且已安装 PyInstaller）。" -f $minVer[0], $minVer[1] -ForegroundColor Red
    Write-Host "建议：在任意 Python 下执行 'python -m pip install pyinstaller' 后重试。" -ForegroundColor Yellow
    exit 3
}
Write-Ok ("使用 $py (Python $pyVer)")

# ---- 2) 确保 PyInstaller 可用 ----
if (-not $pyiVer) {
    Write-Step 2 "安装 PyInstaller（当前解释器缺失）"
    & $py -m pip install --upgrade pip | Out-Null
    & $py -m pip install pyinstaller
    $pyiVer = Test-HasPyInstaller $py
    if (-not $pyiVer) { Write-Host "PyInstaller 安装失败，请检查网络/权限。" -ForegroundColor Red; exit 4 }
} else {
    Write-Step 2 "PyInstaller 已就绪 (v$pyiVer)"
}

# ---- 3) 入口文件检查 ----
if (-not (Test-Path $entry)) {
    Write-Host "入口文件不存在：$entry" -ForegroundColor Red; exit 5
}
Write-Step 3 "入口文件确认：$entry"

# ---- 3.5) 先同步前端，确保 dist/assets 已清理开发测试文件 ----
Write-Step 3.5 "同步前端（确保 dist/assets 不含 _*.test.mjs）"
$feScript = Join-Path $ScriptDir 'build_frontend.ps1'
if (Test-Path $feScript) {
    & $feScript
    if ($LASTEXITCODE -ne 0) {
        Write-Host "前端同步失败（build_frontend.ps1 返回 $LASTEXITCODE），中止打包。" -ForegroundColor Red
        exit 8
    }
    Write-Ok "前端已同步，dist/assets 为干净发布版本"
} else {
    Write-Warn ("未找到 $feScript，跳过前端同步；将直接使用现有 dist/assets（可能含测试文件）")
}

# ---- 4) 组装 PyInstaller 参数 ----
Write-Step 4 "组装 PyInstaller 命令"
$argsList = [System.Collections.Generic.List[string]]::new()
$argsList.Add('--noconfirm')
$argsList.Add('--clean')
if ($build.onefile) { $argsList.Add('--onefile') } else { $argsList.Add('--onedir') }
if (-not $build.console) { $argsList.Add('--noconsole') }
$argsList.Add('--name'); $argsList.Add($build.exe_name)
$argsList.Add('--distpath'); $argsList.Add($distDir)
$argsList.Add('--workpath'); $argsList.Add($workDir)
$argsList.Add('--specpath'); $argsList.Add($specDir)
if ($build.icon -and (Test-Path (Join-Path $root $build.icon))) {
    $argsList.Add('--icon'); $argsList.Add((Join-Path $root $build.icon))
}
foreach ($hi in $build.hidden_imports) { $argsList.Add('--hidden-import'); $argsList.Add($hi) }
# 收集整个子包（uvicorn/anyio/starlette 等的动态子模块，避免运行时 ImportError）
if ($build.PSObject.Properties.Name -contains 'collect_submodules') {
    foreach ($cs in $build.collect_submodules) { $argsList.Add('--collect-submodules'); $argsList.Add($cs) }
}
foreach ($pair in $build.add_data) {
    $src = Join-Path $root $pair[0]
    if (Test-Path $src) {
        $argsList.Add('--add-data'); $argsList.Add(("{0};{1}" -f $src, $pair[1]))
    } else {
        Write-Warn ("add-data 源缺失，跳过：$src")
    }
}
$argsList.Add($entry)

Write-Host ("  pyinstaller " + ($argsList -join ' ')) -ForegroundColor Gray

# ---- 4.5) 停止可能正在运行的旧实例，释放 dist/CodexQQSkin.exe 文件锁 ----
Write-Step 4.5 "停止可能运行的旧实例（释放 dist 文件锁）"
# 仅按映像名结束本项目自带打包服务；绝不无差别强杀占用 8080 的其它进程。
# 旧实例若正在运行，会锁住 dist/CodexQQSkin.exe，导致 PyInstaller 无法覆盖而报 WinError 5。
$eapPrev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& taskkill /IM CodexQQSkin.exe /F 2>$null
$ErrorActionPreference = $eapPrev
Write-Ok "已尝试结束旧实例（若不存在则忽略）"

# ---- 5) 执行打包 ----
Write-Step 5 "执行打包（预计 30-90 秒）"
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
# PyInstaller 会向 stderr 写 WARNING；在 $ErrorActionPreference='Stop' 下会被当成
# 终止错误而 abort。仅在本机调用处临时放宽到 Continue：stderr 照常显示但不中断，
# 真正的失败以 $LASTEXITCODE 判定（下方 $rc -ne 0 处理）。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $py -m PyInstaller @argsList
$rc = $LASTEXITCODE
$ErrorActionPreference = $prevEap
$sw.Stop()
if ($rc -ne 0) {
    Write-Host ("PyInstaller 返回非零退出码：$rc") -ForegroundColor Red
    exit 6
}
Write-Ok ("打包完成，耗时 {0:N1}s" -f $sw.Elapsed.TotalSeconds)

# ---- 6) 校验产物 ----
Write-Step 6 "校验产物 dist/CodexQQSkin.exe"
$exePath = Join-Path $distDir $build.exe_name
if (-not (Test-Path $exePath)) {
    Write-Host "未生成产物：$exePath" -ForegroundColor Red; exit 7
}
$sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 2)
Write-Ok ("产物存在：$exePath  ($sizeMB MB)")

# ---- 7) 复制配套文件到 dist ----
Write-Step 7 "复制配套文件到 dist/"
foreach ($cf in $build.companion_files) {
    # 脚本已统一收纳到 script/：优先 script/<cf>，其次根目录 <cf>
    $src = Join-Path $root ('script' + [System.IO.Path]::DirectorySeparatorChar + $cf)
    if (-not (Test-Path $src)) { $src = Join-Path $root $cf }
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $distDir $cf) -Force
        Write-Ok ("已复制 $cf （源：$src）")
    } else {
        Write-Warn ("配套文件缺失，跳过：$cf")
    }
}

Write-Host "====== 打包完成 ======" -ForegroundColor Green
Write-Host ("可直接运行：dist\CodexQQSkin.exe  或  script\start.bat") -ForegroundColor Cyan
exit 0
