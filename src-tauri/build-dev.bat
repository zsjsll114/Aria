@echo off
rem auto-detect MSVC build environment via vswhere (no hard-coded path)
set "VCVARS="
for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VCVARS=%%i"
if defined VCVARS ( set "VCVARS=%VCVARS%\VC\Auxiliary\Build\vcvars64.bat" )
if not exist "%VCVARS%" (
    echo [ERROR] MSVC build tools not found ^(vcvars64.bat^).
    echo Install VS 2022+ with the "Desktop development with C++" workload.
    exit /b 1
)
call "%VCVARS%"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0"
cargo build
echo CARGO_EXIT=%ERRORLEVEL%