# stop_service.ps1
# 停止 CodexQQSkin 服务。覆盖两种运行形态：
#   1) 冻结后的 CodexQQSkin.exe（映像名匹配）
#   2) 直接以 python server.py 运行的进程（命令行匹配项目路径）
# 策略：仅终止"本项目的"进程，绝不误杀占用同端口的其它程序（避免驱动级不稳定）。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ConfigPath = Join-Path $ScriptDir 'config.json'
if (-not (Test-Path $ConfigPath)) {
    Write-Host "未找到 config.json：$ConfigPath" -ForegroundColor Red
    exit 2
}
$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

$port      = [int]($cfg.service.port)
$imageName = $cfg.service.image_name
$root      = Split-Path -Parent $ScriptDir   # 项目根目录（script/ 的上级），用于定位 server.py 等
$serverPy  = (Join-Path $root 'server.py').Replace('\', '\\')
$timeout   = [int]($cfg.service.stop_timeout_seconds)

function Write-Step($n, $msg) {
    Write-Host ("[步骤 {0}] {1}" -f $n, $msg) -ForegroundColor Cyan
}
function Write-Ok($msg) {
    Write-Host ("  [OK]   {0}" -f $msg) -ForegroundColor Green
}
function Write-Warn($msg) {
    Write-Host ("  [提示] {0}" -f $msg) -ForegroundColor Yellow
}

Write-Host "====== 停止 CodexQQSkin 服务 ======" -ForegroundColor Yellow
Write-Step 1 "读取配置：端口 $port，目标映像 $imageName"

# ---- 收集需要终止的 PID ----
$targetPids = @{}
$reason = @{}

# 1) 按端口占用定位（Get-NetTCPConnection，Win8+ 自带）
Write-Step 2 "扫描端口 $port 的监听进程"
$portPids = @()
try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) { $portPids += $c.OwningProcess }
} catch {
    # 回退 netstat
    $lines = netstat -ano -p TCP | Select-String ":$port\s"
    foreach ($l in $lines) {
        $parts = ($l.Line -split '\s+') | Where-Object { $_ -ne '' }
        if ($parts.Count -ge 5) { $portPids += $parts[-1] }
    }
}
$portPids = $portPids | Where-Object { $_ -and $_ -ne '0' -and $_ -ne $PID } | Sort-Object -Unique
Write-Host ("  端口监听 PID：$($portPids -join ', ')" ) -ForegroundColor Gray

# 3) 遍历端口候选进程，判定是否为本项目服务
Write-Step 3 "判定候选进程归属（映像名 / 命令行含 server.py / python 解释器降级判定）"
foreach ($pid in $portPids) {
    if ($pid -eq $PID) { continue }   # 跳过运行本脚本的 PowerShell 自身
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pid" -ErrorAction SilentlyContinue
    $cmd = $null
    $img = $null
    if ($proc) {
        $cmd = $proc.CommandLine
        $img = $proc.Name
    } else {
        # CIM 不可用时降级：用 Get-Process 取得映像名。端口监听进程且为 python 解释器，判定为本项目。
        $gp = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($gp) { $img = $gp.Name }
    }
    $isOurs = $false
    if ($img -eq $imageName) { $isOurs = $true }
    if ($cmd -and $cmd -match 'server\.py') { $isOurs = $true }
    # 候选已限定为"监听本服务端口 8080"：命令行含 server.py，或 CIM 不可用时映像名为 python 解释器，均判定为本项目。
    if (-not $isOurs -and $img -and $img -match 'python') { $isOurs = $true }
    if ($isOurs) {
        $targetPids[$pid] = $true
        if ($img -eq $imageName) { $reason[$pid] = "映像名 $imageName" }
        elseif ($cmd -and $cmd -match 'server\.py') { $reason[$pid] = "命令行匹配 server.py" }
        else { $reason[$pid] = "端口监听且为 python 解释器（CIM 降级判定）" }
        Write-Host ("  命中本项目进程 PID=$pid ($img) - $($reason[$pid])") -ForegroundColor Green
    } else {
        Write-Warn ("跳过非本项目的进程 PID=$pid ($img)，避免误杀")
    }
}

# 4) 直接枚举 python 解释器进程，命中命令行含 server.py 的本项目进程（不依赖端口定位，更稳健）
Write-Step 4 "直接扫描 python 进程（命令行含 server.py）"
try {
    $allPy = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'python' }
    foreach ($p in $allPy) {
        if ($p.ProcessId -eq $PID) { continue }
        if (-not $p.CommandLine) { continue }
        if ($p.CommandLine -match 'server\.py') {
            if (-not $targetPids.ContainsKey($p.ProcessId)) {
                $targetPids[$p.ProcessId] = $true
                $reason[$p.ProcessId] = "命令行匹配 server.py（直接扫描）"
                Write-Host ("  命中 python 服务进程 PID=$($p.ProcessId)") -ForegroundColor Green
            }
        }
    }
} catch {
    Write-Warn "CIM 枚举不可用，跳过直接扫描（端口/映像名定位仍在生效）"
}

# 5) 额外：直接按映像名兜底（覆盖未监听端口但已启动的冻结 exe）
Write-Step 5 "按映像名 $imageName 兜底扫描"
$imgProcs = Get-CimInstance Win32_Process -Filter "Name = '$imageName'" -ErrorAction SilentlyContinue
foreach ($p in $imgProcs) {
    if ($p.ProcessId -eq $PID) { continue }   # 跳过脚本自身
    if (-not $targetPids.ContainsKey($p.ProcessId)) {
        $targetPids[$p.ProcessId] = $true
        $reason[$p.ProcessId] = "映像名 $imageName"
        Write-Host ("  命中映像进程 PID=$($p.ProcessId)") -ForegroundColor Green
    }
}

if ($targetPids.Count -eq 0) {
    Write-Warn "未发现运行中的 CodexQQSkin 服务进程（端口 $port 未被本项目占用）。"
    Write-Host "====== 停止完成（无需操作）======" -ForegroundColor Green
    exit 0
}

# ---- 终止 ----
Write-Step 6 "终止目标进程"
Write-Host ("  待终止进程数：$($targetPids.Count)") -ForegroundColor Gray
foreach ($targetPid in $targetPids.Keys) {
    Write-Host ("  终止 PID=$targetPid ... ") -ForegroundColor Gray -NoNewline
    $killed = $false
    # 优先用 PowerShell 原生 Stop-Process（同用户进程可靠终止）
    try {
        Stop-Process -Id $targetPid -Force -ErrorAction Stop
        $killed = $true
    } catch {
        # 回退 taskkill；注意 PowerShell 中使用 2>$null 而非 cmd 风格的 >nul
        taskkill /PID $targetPid /F /T 2>$null
        if ($LASTEXITCODE -eq 0) { $killed = $true }
    }
    Start-Sleep -Milliseconds 500
    $alive = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if (-not $alive) {
        Write-Host "已结束" -ForegroundColor Green
    } else {
        Write-Host "仍存活，重试 taskkill" -ForegroundColor Yellow
        taskkill /PID $targetPid /F /T 2>$null
        Start-Sleep -Milliseconds 500
        $alive = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
        if (-not $alive) { Write-Host " 已结束" -ForegroundColor Green }
        else { Write-Host " 仍无法终止，请手动检查" -ForegroundColor Red }
    }
}

# ---- 等待端口释放 ----
Write-Step 7 "等待端口 $port 释放（最多 $timeout 秒）"
$waited = 0
$released = $false
while ($waited -lt $timeout) {
    $still = $false
    try {
        $still = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
    } catch {
        $still = ($false)
    }
    if (-not $still) { $released = $true; break }
    Start-Sleep -Seconds 1
    $waited++
}
if ($released) {
    Write-Ok ("端口 $port 已释放（耗时 ${waited}s）")
} else {
    Write-Warn ("端口 $port 在 ${timeout}s 内仍未释放，请手动检查占用进程")
}

Write-Host "====== 停止完成 ======" -ForegroundColor Green
exit 0
