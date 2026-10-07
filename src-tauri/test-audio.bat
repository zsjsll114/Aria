@echo off
rem Run aria-audio unit tests (pure ASCII on purpose: PowerShell/cmd read .bat as ANSI).
rem Auto-detect MSVC build environment via vswhere (no hard-coded path).
set "VCVARS="
for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VCVARS=%%i"
if defined VCVARS ( set "VCVARS=%VCVARS%\VC\Auxiliary\Build\vcvars64.bat" )
if not exist "%VCVARS%" (
    echo [ERROR] MSVC build tools not found ^(vcvars64.bat^).
    exit /b 1
)
call "%VCVARS%"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0audio"
cargo test --lib %*
echo CARGO_EXIT=%ERRORLEVEL%
