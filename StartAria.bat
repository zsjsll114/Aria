@echo off
title Aria Launcher (Portable)
cd /d "%~dp0"

set "ARIA_NODE=%~dp0runtime\node.exe"

echo ==========================================
echo   Aria Lyrics Player - Portable Edition
echo ==========================================
echo.

:: Integrity check - the three key files must exist together
if not exist "%~dp0server.exe" (
  echo [ERROR] server.exe is missing. Extract the FULL zip archive
  echo         (7-Zip recommended, never extract partially).
  pause
  exit /b 1
)
if not exist "%~dp0web\index.html" (
  echo [ERROR] web\index.html is missing. Extract the FULL zip archive.
  pause
  exit /b 1
)
if not exist "%ARIA_NODE%" (
  echo [ERROR] runtime\node.exe is missing. Extract the FULL zip archive.
  pause
  exit /b 1
)

:: Start backend fully in background (no console window appears).
:: server.exe serves port 8001 and auto-starts the shazam sidecar
:: (18089) plus the QQ/Kugou/Netease vendor processes (3100/3200/3201).
start "" server.exe

:: Wait for the service, then open the UI in the default browser
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8001/index.html"

echo.
echo If the page does not open automatically, visit:
echo   http://127.0.0.1:8001/index.html
echo To stop Aria completely, run StopAria.bat
timeout /t 2 /nobreak >nul
exit