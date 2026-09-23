@echo off
setlocal enabledelayedexpansion
title Aria Portable Build (one-click)
cd /d "%~dp0"

set "ROOT=%~dp0"
set "OUT=%ROOT%dist\AriaPortable"
set "ZIP=%ROOT%dist\Aria-Portable.zip"
set "BUILD_NO_TAG="

echo ==========================================
echo   Aria - one-click portable build
echo   Usage: build_portable.bat [skip-tauri]
echo ==========================================
echo.

rem ================= 0. tool check =================
where pyinstaller >nul 2>&1 || (echo [ERROR] pyinstaller not found on PATH ^(pip install pyinstaller^) & goto fail)

set "SKIP_TAURI=%~1"

rem ================= pre-flight: kill leftover processes =================
rem   Release file locks held by a previously running Aria instance
rem   (server.exe + portable node sidecars under dist\AriaPortable).
echo [pre] Killing leftover Aria processes to release file locks...
taskkill /f /t /im server.exe >nul 2>&1
taskkill /f /t /im esbuild.exe >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.ExecutablePath -like '*AriaPortable*' } | Stop-Process -Force -ErrorAction SilentlyContinue" >nul 2>&1
timeout /t 2 /nobreak >nul
echo       leftover processes cleaned.

rem ================= 1. server.exe (windowless) =================
echo [1/6] Building server.exe (PyInstaller --noconsole)...
if exist "%ROOT%build\server" rmdir /s /q "%ROOT%build\server" >nul 2>&1
pyinstaller --noconfirm --clean --onefile --noconsole --name server --paths . server.py
if errorlevel 1 (echo [ERROR] PyInstaller failed & goto fail)
if not exist "%ROOT%dist\server.exe" (echo [ERROR] dist\server.exe not produced & goto fail)
echo       server.exe OK  ^(windowless GUI subsystem^)

rem ================= 2. Aria.exe (optional; skip with "skip-tauri") =================
set "ARIA_EXE=%ROOT%src-tauri\target\release\aria-player.exe"
if /i "%SKIP_TAURI%"=="skip-tauri" goto tauri_done
echo [2/6] Building Aria.exe (cargo build --release)...
rem auto-detect MSVC via vswhere (no hard-coded path)
set "VCVARS="
for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VCVARS=%%i"
if defined VCVARS ( set "VCVARS=%VCVARS%\VC\Auxiliary\Build\vcvars64.bat" )
if not exist "%VCVARS%" (
    echo [WARN] MSVC C++ build tools not found - Aria.exe will be SKIPPED ^(web-only package^)
    set "SKIP_TAURI=skip-tauri"
    goto tauri_done
)
call "%VCVARS%" >nul 2>&1
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cargo build --release --manifest-path "%ROOT%src-tauri\Cargo.toml"
if errorlevel 1 (echo [WARN] cargo build failed - package will be web-only & set "SKIP_TAURI=skip-tauri")
:tauri_done

rem ================= 3. fresh output dir =================
echo [3/6] Assembling %OUT% ...
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%" >nul 2>&1 || (echo [ERROR] cannot create output dir & goto fail)
mkdir "%OUT%\cache" >nul 2>&1
mkdir "%OUT%\local_music" >nul 2>&1
mkdir "%OUT%\runtime" >nul 2>&1
mkdir "%OUT%\scripts" >nul 2>&1
mkdir "%OUT%\node_modules" >nul 2>&1
mkdir "%OUT%\_eval" >nul 2>&1
mkdir "%OUT%\src-tauri" >nul 2>&1

copy /y "%ROOT%dist\server.exe" "%OUT%\server.exe" >nul
if not exist "%OUT%\server.exe" (echo [ERROR] server.exe not copied & goto fail)

if exist "%ARIA_EXE%" (copy /y "%ARIA_EXE%" "%OUT%\Aria.exe" >nul && echo       Aria.exe OK) else (echo       [WARN] Aria.exe not built)

rem --- web frontend (static only, no user data) ---
robocopy "%ROOT%web" "%OUT%\web" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [ERROR] web copy failed & goto fail)

rem --- portable node runtime ---
set "NODE_SRC="
if exist "%ROOT%dist_runtime\node.exe" set "NODE_SRC=%ROOT%dist_runtime\node.exe"
if not defined NODE_SRC if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_SRC=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_SRC for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_SRC set "NODE_SRC=%%i"
if not defined NODE_SRC (echo [ERROR] no node.exe source - place one at dist_runtime\node.exe & goto fail)
copy /y "%NODE_SRC%" "%OUT%\runtime\node.exe" >nul

rem --- shazam sidecar: script + minimal node_modules ---
copy /y "%ROOT%scripts\shazam-server.mjs" "%OUT%\scripts\shazam-server.mjs" >nul
robocopy "%ROOT%node_modules\shazamio-core" "%OUT%\node_modules\shazamio-core" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [ERROR] shazamio-core copy failed & goto fail)
robocopy "%ROOT%node_modules\@ffmpeg-installer" "%OUT%\node_modules\@ffmpeg-installer" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [ERROR] ffmpeg-installer copy failed & goto fail)

rem --- self-host vendors (exclude VCS/docs/tests) ---
robocopy "%ROOT%_eval\qq-music-api-node" "%OUT%\_eval\qq-music-api-node" /E /XD .git .github docs tests coverage /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [ERROR] qq vendor copy failed & goto fail)
robocopy "%ROOT%_eval\KuGouMusicApi" "%OUT%\_eval\KuGouMusicApi" /E /XD .git /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [ERROR] kugou vendor copy failed & goto fail)
robocopy "%ROOT%_eval\NeteaseCloudMusicApi" "%OUT%\_eval\NeteaseCloudMusicApi" /E /XD .git /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [ERROR] netease vendor copy failed & goto fail)

rem --- icons + launchers + readme ---
robocopy "%ROOT%src-tauri\icons" "%OUT%\src-tauri\icons" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [ERROR] icons copy failed & goto fail)
copy /y "%ROOT%StartAria.bat" "%OUT%\StartAria.bat" >nul
copy /y "%ROOT%StopAria.bat" "%OUT%\StopAria.bat" >nul
copy /y "%ROOT%docs\portable-README.txt" "%OUT%\README.txt" >nul

echo       assembled.

rem ================= 4. vendor integrity spot-check =================
echo [4/6] Spot-checking key files...
for %%F in (
  "%OUT%\web\index.html"
  "%OUT%\runtime\node.exe"
  "%OUT%\scripts\shazam-server.mjs"
  "%OUT%\node_modules\shazamio-core\package.json"
  "%OUT%\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe"
  "%OUT%\_eval\qq-music-api-node\src\app.ts"
  "%OUT%\_eval\qq-music-api-node\node_modules\tsx\dist\cli.mjs"
  "%OUT%\_eval\KuGouMusicApi\app.js"
  "%OUT%\_eval\NeteaseCloudMusicApi\app.js"
  "%OUT%\StartAria.bat"
  "%OUT%\README.txt"
) do (
  if exist "%%~F" (echo       [OK] %%~nF) else (echo       [MISSING] %%~F & set "BUILD_NO_TAG=1")
)
if defined BUILD_NO_TAG (echo [ERROR] integrity spot-check failed & goto fail)

rem ================= 5. zip =================
echo [5/6] Creating %ZIP% ...
if exist "%ZIP%" del /q "%ZIP%"
tar -a -c -f "%ZIP%" -C "%ROOT%dist" AriaPortable
if errorlevel 1 (echo [ERROR] tar failed & goto fail)

for %%A in ("%ZIP%") do echo       zip created: %%~zA bytes

rem ================= 6. verify zip members =================
echo [6/6] Verifying zip members...
set "BAD="
for %%M in (
  "AriaPortable/server.exe"
  "AriaPortable/web/index.html"
  "AriaPortable/runtime/node.exe"
  "AriaPortable/scripts/shazam-server.mjs"
  "AriaPortable/node_modules/shazamio-core/package.json"
  "AriaPortable/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe"
  "AriaPortable/_eval/qq-music-api-node/src/app.ts"
  "AriaPortable/_eval/KuGouMusicApi/app.js"
  "AriaPortable/_eval/NeteaseCloudMusicApi/app.js"
  "AriaPortable/StartAria.bat"
  "AriaPortable/README.txt"
) do (
  tar -tf "%ZIP%" | findstr /b /c:"%%~M" >nul && (echo       [OK] %%~M) || (echo       [MISSING] %%~M & set "BAD=1")
)

echo.
echo   Personal data check ^(expect 0 for each^):
for %%P in (user_config recognize_cache selfhost_login) do (
  set /a cnt=0
  for /f %%n in ('tar -tf "%ZIP%" ^| findstr /i "%%~P" ^| find /c /v ""') do set cnt=%%n
  echo     %%~P: !cnt!
)
set /a cnt=0
for /f %%n in ('tar -tf "%ZIP%" ^| findstr /i "cache/audio local_music/" ^| find /c /v ""') do set cnt=%%n
echo     cache:audio+local_music: !cnt!

if defined BAD (echo.
  echo [ERROR] zip member check failed & goto fail)

echo.
echo ==========================================
echo   BUILD DONE.
echo   Package: %ZIP%
echo   Folder : %OUT%
echo ==========================================
goto :eof

:fail
echo.
echo   BUILD FAILED - see messages above.
pause
exit /b 1