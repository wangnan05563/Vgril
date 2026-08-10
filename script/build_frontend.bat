@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "NO_PAUSE=0"
echo %* | findstr /i "nopause" >nul 2>nul
if not errorlevel 1 set "NO_PAUSE=1"
chcp 65001 >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build_frontend.ps1" %*
set "RC=%errorlevel%"
if %RC% neq 0 (
  echo [FAIL] build_frontend exited with code %RC%
)
if "%NO_PAUSE%"=="0" pause >nul
endlocal
exit /b %RC%
