@echo off
setlocal
set PORT=8080
REM Clear stale proxy vars to avoid outbound API timeouts (HeyGen/LLM); seen 502 / 30s in practice.
REM To keep a proxy for outbound traffic, set KEEP_PROXY=1 before launching.
if not defined KEEP_PROXY (
  set "HTTPS_PROXY="
  set "HTTP_PROXY="
  set "https_proxy="
  set "http_proxy="
)
cd /d "%~dp0.."

REM Only kill our own leftover packaged server by image name.
REM Never force-kill arbitrary processes occupying port 8080. The old logic could
REM kill system or other apps and trigger driver-level instability or a BSOD. If 8080
REM is still taken, server.py falls back to 8081-8089 automatically.
taskkill /IM CodexQQSkin.exe /F >nul 2>nul

REM Prefer the packaged zero-dependency exe in the current folder.
if exist CodexQQSkin.exe (
  echo Starting Codex-QQ-Skin packaged exe on port %PORT% ...
  start "CodexQQSkin Server" CodexQQSkin.exe
  echo Server window opened; the browser opens automatically.
  echo Close that window to stop the server. Press any key to close this launcher.
  pause >nul
  endlocal
  exit /b 0
)

REM Also accept the exe shipped inside dist/.
if exist dist\CodexQQSkin.exe (
  echo Starting Codex-QQ-Skin packaged exe in dist/ on port %PORT% ...
  start "CodexQQSkin Server" dist\CodexQQSkin.exe
  echo Server window opened; the browser opens automatically.
  echo Close that window to stop the server. Press any key to close this launcher.
  pause >nul
  endlocal
  exit /b 0
)

REM Fallback: run server.py directly with a detected Python interpreter.
set PY=
where py >nul 2>nul && set PY=py
if not defined PY ( where python3 >nul 2>nul && set PY=python3 )
if not defined PY ( where python >nul 2>nul && set PY=python )
if not defined PY (
  echo Python 3 not found. Install Python from https://www.python.org
  pause
  exit /b 1
)

echo Starting Codex-QQ-Skin on port %PORT% ...
powershell -NoProfile -Command "exit [int](-not (Test-NetConnection -ComputerName 127.0.0.1 -Port %PORT% -Quiet -WarningAction SilentlyContinue))"
if %errorlevel%==0 (
  echo Server already running on port %PORT%.
) else (
  start "Codex-QQ-Skin Server" cmd /k "%PY% server.py"
)

timeout /t 2 >nul
start "" "http://127.0.0.1:%PORT%/index.html"
echo.
echo Server window opened. Close that window to stop the server.
echo Press any key to close this launcher.
pause >nul
endlocal
