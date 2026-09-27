@echo off
setlocal enabledelayedexpansion
title Aria Portable Build (one-click)
cd /d "%~dp0"

set "ROOT=%~dp0"
rem Pin Windows' own tools first: when this runs from a git-bash PATH, `find` resolves to
rem GNU find (which then walks the whole drive instead of counting lines) and `timeout` /
rem `tar` break the same way. System32 first makes the script behave identically no matter
rem who launches it; pyinstaller/cargo/git/node all live further down PATH and still resolve.
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
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

rem ================= 0.1 args =================
rem   build_portable.bat [skip-tauri] [--with-local-fonts]
rem     skip-tauri          no Aria.exe (web-only package)
rem     --with-local-fonts  FAT mode: also put the author's private fonts (the ones
rem                         .gitignore hides, measured 89MB) into the main package.
rem                         Default ships only the repo-tracked fonts and packs the
rem                         rest into dist\AriaFonts-Extra.zip - together they equal
rem                         everything on disk, nothing is lost.
set "SKIP_TAURI="
set "WITH_LOCAL_FONTS="
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="skip-tauri" set "SKIP_TAURI=skip-tauri"
if /i "%~1"=="--with-local-fonts" set "WITH_LOCAL_FONTS=1"
shift
goto parse_args
:args_done

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
rem   dist\AriaPortable is often someone's day-to-day install: user_config.json (settings /
rem   favorites / reverse-proxy token) and cache/ (vendor logins) live right there, and the
rem   rmdir below used to erase them with the build output - that destroyed data on
rem   2026-09-26. So move them aside first and put them back after packaging. The shipped
rem   zip stays clean on purpose (the Personal data check below still reports zero); only
rem   the local folder gets its data back.
set "KEEP=%ROOT%dist\_portable_userdata"
if exist "%KEEP%" rmdir /s /q "%KEEP%"
set "HAD_USERDATA="
if exist "%OUT%\user_config.json" (
    mkdir "%KEEP%" >nul 2>&1
    copy /y "%OUT%\user_config.json" "%KEEP%\user_config.json" >nul
    set "HAD_USERDATA=cfg"
)
if exist "%OUT%\cache" (
    mkdir "%KEEP%" >nul 2>&1
    robocopy "%OUT%\cache" "%KEEP%\cache" /E /NFL /NDL /NJH /NJS /NP >nul
    set "HAD_USERDATA=!HAD_USERDATA! cache"
)
if defined HAD_USERDATA echo       preserving existing install data:!HAD_USERDATA!
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
rem   web\src\font mixes app fonts with the author's private collection (the font picker
rem   just lists that directory - see 215-multilang-fonts.js). The private ones are
rem   gitignored and measured 89MB; a machine installing from this repo never had them,
rem   so the default package carries only git-tracked fonts and the rest goes to
rem   dist\AriaFonts-Extra.zip (README explains how to restore). --with-local-fonts = FAT.
if defined WITH_LOCAL_FONTS (
    echo       fonts: FAT mode ^(all of web\src\font into the main package^)
    robocopy "%ROOT%web" "%OUT%\web" /E /NFL /NDL /NJH /NJS /NP >nul
    if errorlevel 8 (echo [ERROR] web copy failed & goto fail)
    goto fonts_done
)
robocopy "%ROOT%web" "%OUT%\web" /E /XD "%ROOT%web\src\font" /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [ERROR] web copy failed & goto fail)

set "GIT_EXE="
where git >nul 2>&1 && set "GIT_EXE=git"
if not defined GIT_EXE (
    echo       [WARN] git not found - cannot tell repo fonts from local ones, copying ALL
    robocopy "%ROOT%web\src\font" "%OUT%\web\src\font" /E /NFL /NDL /NJH /NJS /NP >nul
    goto fonts_done
)

mkdir "%OUT%\web\src\font" >nul 2>&1
for /f "delims=" %%F in ('git -C "%~dp0." ls-files web/src/font') do (
    copy /y "%ROOT%web\src\font\%%~nxF" "%OUT%\web\src\font\%%~nxF" >nul
)
set /a FONT_TRACKED=0
for /f %%n in ('git -C "%~dp0." ls-files web/src/font ^| find /c /v ""') do set /a FONT_TRACKED=%%n
set /a FONT_COPIED=0
for /f %%n in ('dir /b /a-d "%OUT%\web\src\font\*" 2^>nul ^| find /c /v ""') do set /a FONT_COPIED=%%n
if !FONT_COPIED! LSS !FONT_TRACKED! (
    echo [ERROR] font copy incomplete: repo tracks !FONT_TRACKED! files, package has !FONT_COPIED!
    echo         if a repo font ever lives in a subfolder, copy by relative path instead
    goto fail
)
echo       fonts: !FONT_COPIED!/!FONT_TRACKED! repo-bundled into main package

rem --- local-only fonts (gitignored) into a separate extra pack: nothing is lost ---
set "EXTRA_DIR=%ROOT%dist\AriaFontsExtra"
set "EXTRA_ZIP=%ROOT%dist\AriaFonts-Extra.zip"
if exist "%EXTRA_DIR%" rmdir /s /q "%EXTRA_DIR%"
robocopy "%ROOT%web\src\font" "%EXTRA_DIR%\web\src\font" /E /NFL /NDL /NJH /NJS /NP >nul
for /f "delims=" %%F in ('git -C "%~dp0." ls-files web/src/font') do (
    del /q "%EXTRA_DIR%\web\src\font\%%~nxF" >nul 2>&1
)
set /a EXTRA_CNT=0
for /f %%n in ('dir /b /s /a-d "%EXTRA_DIR%" 2^>nul ^| find /c /v ""') do set /a EXTRA_CNT=%%n
if !EXTRA_CNT! GTR 0 (
    if exist "%EXTRA_ZIP%" del /q "%EXTRA_ZIP%"
    tar -a -c -f "%EXTRA_ZIP%" -C "%EXTRA_DIR%" web
    if errorlevel 1 (echo [ERROR] font extra pack failed & rmdir /s /q "%EXTRA_DIR%" & goto fail)
    for %%A in ("%EXTRA_ZIP%") do echo       fonts: !EXTRA_CNT! local-only file^(s^) -^> AriaFonts-Extra.zip ^(%%~zA bytes^)
) else (
    echo       fonts: no local-only files, extra pack skipped
)
rmdir /s /q "%EXTRA_DIR%"
:fonts_done

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

rem --- optional slot: slim ffmpeg build ---
rem   The shipped exe measures 64,458,752 bytes (full static build) while recognition only
rem   decodes to 16kHz mono WAV once (scripts/shazam-server.mjs). Drop any slim ffmpeg.exe
rem   at dist_runtime\ffmpeg.exe and it replaces the file in place: the path exported by
rem   require('@ffmpeg-installer/ffmpeg') stays the same, so no code changes. Absent = today.
if exist "%ROOT%dist_runtime\ffmpeg.exe" (
    copy /y "%ROOT%dist_runtime\ffmpeg.exe" "%OUT%\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe" >nul
    for %%A in ("%OUT%\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe") do echo       ffmpeg: replaced by dist_runtime\ffmpeg.exe ^(%%~zA bytes^)
) else (
    echo       ffmpeg: using @ffmpeg-installer default ^(62MB^); drop a slim build at dist_runtime\ffmpeg.exe to shrink
)

rem --- self-host vendors (exclude VCS/docs/tests) ---
rem   /XF drops only *.md / *.map (10.6MB across the three node_modules; Node never reads
rem   them). *.d.ts stays on purpose: the QQ vendor runs .ts through tsx at runtime and
rem   3.4MB is not worth risking type resolution. LICENSE files are always kept.
robocopy "%ROOT%_eval\qq-music-api-node" "%OUT%\_eval\qq-music-api-node" /E /XD .git .github docs tests coverage /XF *.md *.map /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [ERROR] qq vendor copy failed & goto fail)
robocopy "%ROOT%_eval\KuGouMusicApi" "%OUT%\_eval\KuGouMusicApi" /E /XD .git .github docs examples /XF *.md *.map /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [ERROR] kugou vendor copy failed & goto fail)
robocopy "%ROOT%_eval\NeteaseCloudMusicApi" "%OUT%\_eval\NeteaseCloudMusicApi" /E /XD .git .github docs example /XF *.md *.map /NFL /NDL /NJH /NJS /NP >nul
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
  "%OUT%\web\remote.html"
  "%OUT%\web\src\font\LXGWNeoXiHei.ttf"
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
rem   Prefer bsdtar deflate level 9 (System32\tar.exe supports --options); an older tar
rem   rejects it, so retry with defaults - making the zip smaller must never break a build.
tar -a --options "zip:compression=deflate:compression_level=9" -c -f "%ZIP%" -C "%ROOT%dist" AriaPortable 2>nul
if errorlevel 1 (
    echo       [INFO] this tar has no zip compression-level option, using default
    if exist "%ZIP%" del /q "%ZIP%"
    tar -a -c -f "%ZIP%" -C "%ROOT%dist" AriaPortable
)
if errorlevel 1 (echo [ERROR] tar failed & goto fail)

for %%A in ("%ZIP%") do echo       zip created: %%~zA bytes
powershell -NoProfile -Command "$s=(Get-ChildItem -LiteralPath '%OUT%' -Recurse -File | Measure-Object -Property Length -Sum).Sum; '       folder total: {0:N1} MB' -f ($s/1MB)" 2>nul
echo       ---- 6 largest files in the package (size regressions show up here) ----
powershell -NoProfile -Command "Get-ChildItem -LiteralPath '%OUT%' -Recurse -File | Sort-Object Length -Descending | Select-Object -First 6 | ForEach-Object { '       {0,8:N1} MB  {1}' -f ($_.Length/1MB), $_.Name }" 2>nul

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

rem ================= 3.5 put the preserved install data back (AFTER the zip, so the
rem   distributed package stays clean while the local folder keeps working) =================
if not defined HAD_USERDATA goto userdata_done
if exist "%KEEP%\user_config.json" copy /y "%KEEP%\user_config.json" "%OUT%\user_config.json" >nul
if exist "%KEEP%\cache" robocopy "%KEEP%\cache" "%OUT%\cache" /E /NFL /NDL /NJH /NJS /NP >nul
rmdir /s /q "%KEEP%"
echo       restored local install data into %OUT% ^(not in the zip^)
:userdata_done

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