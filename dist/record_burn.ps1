# record_burn.ps1
# Record the Codex-QQ-Skin webpage (or any screen) and optionally burn SRT subtitles.
#
# Modes:
#   .\record_burn.ps1                  -> record full screen, wait for ENTER to stop, burn SRT
#   .\record_burn.ps1 -Duration 90     -> record 90s automatically, then burn SRT
#   .\record_burn.ps1 -VideoFile x.mp4 -> skip recording, just burn SRT into x.mp4
#   .\record_burn.ps1 -NoBurn          -> record only, no subtitle burn
#
# Run:  powershell -ExecutionPolicy Bypass -File record_burn.ps1

param(
  [string]$VideoFile = "",
  [int]$Duration = 60,
  [switch]$NoWait,
  [switch]$NoBurn
)

$ErrorActionPreference = "Stop"

# ---------- config ----------
$Fps      = 30
$BurnSubs = -not $NoBurn
$SubFile  = "xiaoya_subtitles.srt"
$CjkFont  = "Microsoft YaHei"
$OutDir   = "."

# ---------- ensure ffmpeg ----------
function Ensure-FFmpeg {
  if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { return }
  Write-Host "ffmpeg not found. Installing via winget (needs internet)..." -ForegroundColor Yellow
  winget install --id Gyan.FFmpeg -e --source winget --accept-package-agreements --accept-source-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw "ffmpeg still missing. Install manually: winget install Gyan.FFmpeg"
  }
}
Ensure-FFmpeg

# ---------- paths ----------
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$final = Join-Path $OutDir ("xiaoya_final_$timestamp.mp4")

if ($VideoFile -ne "") {
  # burn-only mode
  $raw = $VideoFile
} else {
  $raw = Join-Path $OutDir ("rec_raw_$timestamp.mp4")
  $recArgs = @("-y","-f","gdigrab","-framerate",$Fps,"-i","desktop","-pix_fmt","yuv420p")
  if (-not $NoWait) {
    Read-Host "Make the webpage fullscreen, then press ENTER to START recording"
  } else {
    $recArgs += "-t"; $recArgs += [string]$Duration
    Write-Host "Recording for $Duration seconds..." -ForegroundColor Cyan
  }
  $recArgs += $raw
  $proc = Start-Process -FilePath ffmpeg -ArgumentList $recArgs -NoNewWindow -PassThru
  if (-not $NoWait) {
    Read-Host "Recording now... press ENTER in THIS window to STOP"
    if (-not $proc.HasExited) { $proc.CloseMainWindow() | Out-Null; Start-Sleep 1; if (-not $proc.HasExited) { $proc.Kill() } }
  } else {
    while (-not $proc.HasExited) { Start-Sleep 1 }
  }
  Write-Host "Raw capture saved." -ForegroundColor Green
}

# ---------- burn subtitles ----------
if ($BurnSubs -and (Test-Path $SubFile)) {
  $subPath = (Resolve-Path $SubFile).Path -replace '\\','/'
  $style = "FontName=$CjkFont,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2"
  $filter = "subtitles='$subPath':force_style='$style'"
  $burnArgs = @("-y","-i",$raw,"-vf",$filter,"-c:a","copy","-movflags","+faststart",$final)
  Write-Host "Burning subtitles..." -ForegroundColor Cyan
  Start-Process -FilePath ffmpeg -ArgumentList $burnArgs -NoNewWindow -Wait
  if ($VideoFile -eq "") { Remove-Item $raw -Force }
  Write-Host "DONE -> $final" -ForegroundColor Green
} else {
  if ($VideoFile -eq "") { Move-Item $raw $final }
  else { $final = $raw }
  Write-Host "No subtitle burn. Output -> $final" -ForegroundColor Green
}
