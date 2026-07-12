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

:: The POSIX shell (Git Bash) is provisioned by install-common.mjs itself (its
:: win32 posix-shell step downloads PortableGit when none is present) — bash
:: isn't needed to RUN that script, only Node is, so it doesn't bootstrap here.

:: Portable ZIP FIRST (parity with NodeBootstrap.cs / install.ps1): per-user
:: under %LOCALAPPDATA%, no admin, no winget/App Installer required. winget's
:: Node package installs machine-wide and needs a UAC prompt a non-elevated
:: install can't always raise -- with silent flags it failed with exit 1602
:: ("user cancelled") and no visible prompt. winget is only the fallback.
:: NOTE: comments stay OUTSIDE the ( ) block — cmd parses `::` inside a
:: parenthesized block as a drive-relative path and prints "The system
:: cannot find the drive specified." mid-install.
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [install] Installing Node 24 LTS...
    set "NODE_ARCH=win-x64"
    if /i "!PROCESSOR_ARCHITECTURE!"=="ARM64" set "NODE_ARCH=win-arm64"
    if /i "!PROCESSOR_ARCHITEW6432!"=="ARM64" set "NODE_ARCH=win-arm64"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ver='24.16.0'; $arch='!NODE_ARCH!'; $pkg='node-v'+$ver+'-'+$arch; $zip=Join-Path $env:TEMP ($pkg+'.zip'); $root=Join-Path $env:LOCALAPPDATA 'LocalAgentX'; $nodeDir=Join-Path $root $pkg; try { Invoke-WebRequest -Uri ('https://nodejs.org/dist/v'+$ver+'/'+$pkg+'.zip') -OutFile $zip -UseBasicParsing; if(Test-Path $nodeDir){Remove-Item $nodeDir -Recurse -Force}; New-Item -ItemType Directory -Force -Path $root ^| Out-Null; Expand-Archive -Path $zip -DestinationPath $root -Force; Remove-Item $zip -ErrorAction SilentlyContinue; $u=[Environment]::GetEnvironmentVariable('PATH','User'); if($u -notlike ('*'+$nodeDir+'*')){[Environment]::SetEnvironmentVariable('PATH', ($nodeDir+';'+$u), 'User')} } catch { exit 1 }"
    set "PATH=!LOCALAPPDATA!\LocalAgentX\node-v24.16.0-!NODE_ARCH!;!PATH!"
    where node >nul 2>&1 || (where winget >nul 2>&1 && winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent && set "PATH=!ProgramFiles!\nodejs;!PATH!")
)
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install Node 22+ from https://nodejs.org and re-run.
    exit /b 1
)

node scripts\install-common.mjs %*
endlocal
