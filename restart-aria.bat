@echo off
chcp 65001 >nul
title Aria Restart & Start
echo ==========================================
echo   Aria: force restart + build + start
echo ==========================================
echo.

echo [1/4] Killing Aria desktop...
taskkill /F /IM aria-player.exe /T >nul 2>&1

echo [2/4] Killing leftover backend (port 8001 / 18089)...
powershell -NoProfile -Command ^
  "Get-NetTCPConnection -LocalPort 8001,18089 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ } | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo Waiting for shutdown...
timeout /t 2 /nobreak >nul

rem NOTE: Frontend (web/ + server.py) changes do NOT need cargo build.
rem The app serves web/ via server.py with no-cache; a restart picks it up.
rem Backend (server.py:8001 / shazam-server.mjs:18089) is auto-started by the
rem exe itself, so we no longer start a second one here (that caused a
rem port-8001 race at startup = "works only after a while").

echo [3/4] Building (incremental) and launching...
cd /d "%~dp0src-tauri"
set "VCVARS="
for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VCVARS=%%i"
if defined VCVARS set "VCVARS=%VCVARS%\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS goto no_toolchain
if not exist "%VCVARS%" goto no_toolchain

call "%VCVARS%" >nul 2>&1
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cargo build
if errorlevel 1 goto build_failed

start "" "%~dp0src-tauri\target\debug\aria-player.exe"
echo.
echo Launched. Backend will be auto-started by the app.
goto verify_backend

:no_toolchain
echo [ERROR] MSVC build tools not found. Install VS 2022+ Desktop development with C++.
pause
exit /b 1

:build_failed
echo.
echo BUILD FAILED. Please check Rust / VS2026 toolchain.
pause
exit /b 1

:verify_backend
echo [4/4] Waiting for backend and verifying version...
powershell -NoProfile -Command ^
  "$n=0; while($n++ -lt 15){ try{ $r=Invoke-WebRequest -Uri 'http://localhost:8001/api/version' -UseBasicParsing -TimeoutSec 2; $j=$r.Content | ConvertFrom-Json; Write-Host ('Backend ready - server build time: ' + $j.build_time); exit 0 }catch{ Start-Sleep -Milliseconds 800 } }; Write-Host 'Backend not ready yet (window may still be starting)'; exit 1"

echo.
echo ==================================================
echo  TIPS:
echo  1. Frontend (JS/CSS) changes: just restart the app,
echo     no rebuild needed. If old UI remains, press
echo     Ctrl+Shift+R inside the app window.
echo  2. localStorage / IndexedDB (settings, favorites,
echo     AI cache) is NOT cleared by this script. Use
echo     DevTools -> Application -> Clear storage.
echo  3. Startup instability (works only after a while)
echo     was caused by a double backend on port 8001;
echo     this script no longer starts a second one.
echo ==================================================
pause