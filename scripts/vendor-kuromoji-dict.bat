@echo off
rem ============================================================
rem vendor-kuromoji-dict.bat - copy the kuromoji dictionary into
rem web/src/vendor/kuromoji/dict/ (same-origin, used by the PV
rem word segmenter at runtime).
rem
rem Why: the dictionary is ~17MB of .dat.gz files. Committing it
rem would bloat every clone, so web/src/vendor/kuromoji/dict/ is
rem git-ignored. node_modules/kuromoji/dict already ships those
rem files after `npm install`, so this script just mirrors them.
rem If the folder is missing, the frontend falls back to the
rem jsdelivr CDN and then to the native Intl.Segmenter - the app
rem still works, only Japanese word grouping gets coarser.
rem
rem Requires: npm install already run in the project root.
rem Keep this file ASCII-only (AGENTS.md constraint).
rem ============================================================
setlocal
cd /d "%~dp0.."

set "SRC=node_modules\kuromoji\dict"
set "DST=web\src\vendor\kuromoji\dict"

if not exist "%SRC%\base.dat.gz" (
    echo [ERROR] %SRC%\base.dat.gz not found.
    echo         Run "npm install" in the project root first.
    endlocal
    exit /b 1
)

if not exist "%DST%" mkdir "%DST%"

copy /Y "%SRC%\*.dat.gz" "%DST%\" >nul
if errorlevel 1 (
    echo [ERROR] copy failed: %SRC% -^> %DST%
    endlocal
    exit /b 1
)

set COUNT=0
for %%f in ("%DST%\*.dat.gz") do set /a COUNT+=1
echo [ok] copied %COUNT% dictionary file^(s^) to %DST%

endlocal
exit /b 0
