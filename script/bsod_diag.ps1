# bsod_diag.ps1  ——  只读诊断：抓取最近一次 Windows 蓝屏(BugCheck)原因
#
# 用途：
#   电脑蓝屏重启后，本脚本从「事件查看器 / 系统日志」和 minidump 目录
#   读出最近一次崩溃信息，并把错误码翻译成人话，方便定位是显卡/内存/驱动问题。
#
# 特点：纯只读，不删除、不修改任何系统文件。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File bsod_diag.ps1            # 在屏幕打印报告
#   powershell -ExecutionPolicy Bypass -File bsod_diag.ps1 -Log       # 同时写入 bsod_report.txt
#   powershell -ExecutionPolicy Bypass -File bsod_diag.ps1 -Analyze   # 若装了 WinDbg/cdb，自动分析最新 dump
#
# 注意：以普通用户即可读取系统日志与 minidump；无需管理员。

param(
  [switch]$Log,
  [switch]$Analyze
)

$ErrorActionPreference = "SilentlyContinue"

function CausedBy {
  # 常见 BugCheck 错误码 -> 人话 + 排查方向
  param([string]$Code)
  $map = @{
    "0x0000001E" = "KMODE_EXCEPTION_NOT_HANDLED：内核模式异常。多为驱动 bug / 内存损坏。"
    "0x0000003B" = "SYSTEM_SERVICE_EXCEPTION：系统服务异常。常见于显卡/声卡驱动、杀软。"
    "0x00000050" = "PAGE_FAULT_IN_NONPAGED_AREA：访问了无效内存。重点查内存条 / 坏驱动。"
    "0x0000007E" = "SYSTEM_THREAD_EXCEPTION_NOT_HANDLED：系统线程异常。多为驱动（显卡/网卡）。"
    "0x0000009F" = "DRIVER_POWER_STATE_FAILURE：驱动电源状态故障。常见于显卡/网卡/USB 驱动休眠唤醒。"
    "0x000000A0" = "INTERNAL_POWER_ERROR：内部电源错误。查主板/BIOS/电源。"
    "0x000000D1" = "DRIVER_IRQL_NOT_LESS_OR_EQUAL：驱动在错误中断级访问内存。典型驱动 bug（网卡/显卡/杀软）。"
    "0x000000EA" = "THREAD_STUCK_IN_DEVICE_DRIVER：显卡驱动卡死。几乎必是 GPU 驱动问题。"
    "0x000000F4" = "CRITICAL_OBJECT_TERMINATION：关键进程被终止。常因强制杀进程导致系统关键服务丢失。"
    "0x000000F7" = "DRIVER_OVERRAN_STACK_BUFFER：驱动栈溢出。典型有 bug 的第三方驱动。"
    "0x00000109" = "CRITICAL_STRUCTURE_CORRUPTION：内核结构被改。多为杀软/rootkit 或内存损坏。"
    "0x00000116" = "VIDEO_TDR_FAILURE：显卡超时无响应（TDR）。NVIDIA/AMD 显卡驱动崩溃。"
    "0x00000124" = "WHEA_UNCORRECTABLE_ERROR：硬件不可纠正错误。CPU/内存/主板硬件故障信号。"
    "0x00000133" = "DPC_WATCHDOG_VIOLATION：驱动响应超时。常见于存储/显卡/网卡驱动。"
    "0x00000139" = "KERNEL_MODE_HEAP_CORRUPTION：内核堆损坏。多为驱动 bug。"
    "0x00000153" = "UNEXPECTED_STORE_EXCEPTION：存储异常。查硬盘/SSD/存储驱动。"
    "0x0000024"  = "NTFS_FILE_SYSTEM：NTFS 文件系统错误。查硬盘坏道 / 磁盘驱动。"
    "0x00000019" = "BAD_POOL_HEADER：内存池损坏。多为驱动 bug 或内存损坏。"
    "0x0000000A" = "IRQL_NOT_LESS_OR_EQUAL：中断级非法访问。典型驱动 bug / 坏内存。"
    "0x000000C2" = "BAD_POOL_CALLER：错误的内存池调用。多为有缺陷的驱动。"
    "0x000000C5" = "DRIVER_CORRUPTED_EXPOOL：驱动破坏了内核执行池。第三方驱动 bug。"
  }
  if ($map.ContainsKey($Code)) { return $map[$Code] }
  return "未收录的错误码（$Code）。建议用 WinDbg 打开 minidump 看 !analyze -v 的具体调用栈。"
}

$lines = @()
$lines += "=================================================="
$lines += " 蓝屏(BugCheck)诊断报告  -  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$lines += "=================================================="

# ---------- 1) 基本信息 ----------
$os = Get-CimInstance Win32_OperatingSystem
$lines += ""
$lines += "[系统]"
$lines += "  OS      : $($os.Caption)  Build $($os.BuildNumber)"
$lines += "  已运行  : $([math]::Round(((Get-Date)-$os.LastBootUpTime).TotalHours,1)) 小时 (自 $($os.LastBootUpTime))"

# ---------- 2) 最近一次 BugCheck（来自 WER 1001 / BugCheck 源）----------
$lines += ""
$lines += "[最近一次蓝屏]"
$bug = $null
$evts = Get-WinEvent -FilterHashtable @{LogName='System'} -MaxEvents 3000 | `
        Where-Object { $_.Id -eq 1001 -and ($_.ProviderName -like '*WER*' -or $_.ProviderName -like '*BugCheck*') }
if ($evts) {
  $latest = $evts | Sort-Object TimeCreated -Descending | Select-Object -First 1
  $msg = $latest.Message
  # 从消息里抠出 bugcheck 十六进制码
  if ($msg -match '0x([0-9A-Fa-f]{1,8})') {
    $code = "0x" + ($Matches[1].PadLeft(8,'0'))
    $lines += "  时间    : $($latest.TimeCreated)"
    $lines += "  错误码  : $code"
    $lines += "  含义    : $(CausedBy $code)"
  } else {
    $lines += "  找到重启记录（$($latest.TimeCreated)），但消息中未解析出错误码："
  }
  $lines += "  原始消息: $($msg -replace "`n"," ")"
} else {
  $lines += "  未找到 BugCheck 记录（可能未开启转储，或近期无蓝屏）。"
}

# ---------- 3) minidump 文件清单 ----------
$lines += ""
$lines += "[MiniDump 转储文件]"
$md = Join-Path $env:SystemRoot "Minidump"
if (Test-Path $md) {
  $dumps = Get-ChildItem $md -Filter *.dmp | Sort-Object LastWriteTime -Descending | Select-Object -First 5
  if ($dumps) {
    $lines += "  目录: $md"
    foreach ($d in $dumps) {
      $lines += "    $($d.Name)  ($($d.Length) bytes, $($d.LastWriteTime))"
    }
    $lines += "  提示: 用 WinDbg 打开最新 .dmp -> 输入 '!analyze -v' 看崩溃调用栈与嫌疑驱动。"
  } else {
    $lines += "  目录存在但为空。若曾蓝屏却无 dump，说明未开启『写入小型内存转储』（设置路径见下）。"
  }
} else {
  $lines += "  未找到 $md —— 系统可能未配置 minidump。"
}

# ---------- 4) 转储配置检查 ----------
$lines += ""
$lines += "[转储配置]"
$crash = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl" -ErrorAction SilentlyContinue
if ($crash) {
  $dt = switch ($crash.CrashDumpEnabled) {
    0 { "无 (None)" }
    1 { "完整内存转储 (Complete)" }
    2 { "内核内存转储 (Kernel)" }
    3 { "小型内存转储 (Minidump, 推荐)" }
    7 { "自动内存转储 (Auto)" }
    default { "值=$($crash.CrashDumpEnabled)" }
  }
  $lines += "  CrashDumpEnabled = $dt"
  $lines += "  若不是『小型/内核』，可在：此电脑->右键属性->高级系统设置->启动和故障恢复->设置 中改为『小型内存转储(256KB)』。"
}

# ---------- 5) 可选：调用 WinDbg/cdb 自动分析最新 dump ----------
if ($Analyze) {
  $lines += ""
  $lines += "[自动分析 dump]"
  $cdb = (Get-Command cdb.exe -ErrorAction SilentlyContinue)
  $windbg = (Get-Command windbg.exe -ErrorAction SilentlyContinue)
  $tool = if ($cdb) { $cdb.Source } elseif ($windbg) { $windbg.Source } else { $null }
  if ($tool -and $dumps) {
    $target = $dumps[0].FullName
    $lines += "  使用 $tool 分析 $target ..."
    $res = & $tool -z $target -c "!analyze -v; q" -y "srv*https://msdl.microsoft.com/download/symbols" 2>&1 | Select-String -Pattern "Probably caused by|MODULE_NAME|IMAGE_NAME|BUGCHECK_STR" | ForEach-Object { "    " + $_.Line }
    if ($res) { $lines += $res } else { $lines += "    未能自动提取结论，请手动用 WinDbg 打开查看。" }
  } else {
    $lines += "  未检测到 cdb/windbg，或未找到 dump。请先安装 Windows SDK 的 Debugging Tools。"
  }
}

$lines += ""
$lines += "=================================================="
$report = $lines -join "`n"
Write-Host $report

if ($Log) {
  $out = Join-Path (Split-Path $MyInvocation.MyCommand.Path) "bsod_report.txt"
  $report | Out-File -FilePath $out -Encoding utf8
  Write-Host "`n报告已写入: $out"
}
