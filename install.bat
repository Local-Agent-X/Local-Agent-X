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

where ollama >nul 2>&1
if %errorlevel% neq 0 (
    echo [install] Installing Ollama...
    where winget >nul 2>&1 && winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements -h
    set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
)

node scripts\install-common.mjs
endlocal
