@echo off
:: Local Agent X — Windows CMD installer (thin wrapper).
:: GUI installer is the preferred path — see Install Local Agent X Windows
:: Installer.exe at the repo root. This wrapper exists for CLI users who
:: want the bare-pipe install (no GUI), and as the entry point the GUI
:: installer's child-process invocation ultimately resolves to (via
:: scripts\install-common.mjs --ipc).
::
:: Bootstrap is minimal: ensure Node is present (chicken-and-egg, since
:: install-common.mjs needs Node to run), then hand off. All other install
:: steps (VS Build Tools, Python, Ollama, npm install, model pull, build,
:: shortcuts) now live in scripts\install-common.mjs so a single source of
:: truth covers both CLI and GUI flows.
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

node scripts\install-common.mjs %*
endlocal
