@echo off
:: Local Agent X — Windows CMD installer (thin wrapper).
:: Cross-OS install logic lives in scripts\install-common.mjs.
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [install] Installing Node 22...
    where winget >nul 2>&1 && winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements -h
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install Node 22+ from https://nodejs.org and re-run.
    exit /b 1
)

:: Visual Studio Build Tools (C++ workload) — for native npm modules that
:: have to compile from source. vswhere is the canonical detector.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "HAS_VC=0"
if exist "%VSWHERE%" (
    for /f "delims=" %%i in ('"%VSWHERE%" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul') do set "HAS_VC=1"
)
if "%HAS_VC%"=="0" (
    echo [install] Installing Visual Studio Build Tools ^(C++ workload, ~3 GB, one-time^)...
    where winget >nul 2>&1 && winget install --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements --silent --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
)

:: Python 3.12 (optional voice servers, user scripts)
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [install] Installing Python 3.12...
    where winget >nul 2>&1 && winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements -h
    set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%PATH%"
)

where ollama >nul 2>&1
if %errorlevel% neq 0 (
    echo [install] Installing Ollama...
    where winget >nul 2>&1 && winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements -h
    set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
)

node scripts\install-common.mjs
endlocal
