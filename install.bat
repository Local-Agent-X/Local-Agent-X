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

:: Guarantee a POSIX shell (Git Bash + MSYS2 coreutils) — the runtime assumes
:: one exists. Pinned PortableGit; keep version/sha in sync with
:: installer\Services\GitBootstrap.cs (GIT_PORTABLE_VERSION/SHA256) + install.ps1.
set "GIT_PORTABLE_VERSION=2.54.0"
set "GIT_PORTABLE_SHA256=bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311"
set "GITDIR=%LOCALAPPDATA%\LocalAgentX\PortableGit"
set "HAVEBASH="
if exist "%GITDIR%\bin\bash.exe" set "HAVEBASH=1"
where git >nul 2>&1 && set "HAVEBASH=1"
if not defined HAVEBASH (
    echo [install] Installing Git for Windows ^(POSIX shell^)...
    where winget >nul 2>&1 && winget install Git.Git --accept-package-agreements --accept-source-agreements --silent
    set "PATH=%ProgramFiles%\Git\cmd;%ProgramFiles%\Git\bin;%PATH%"
    where git >nul 2>&1 && set "HAVEBASH=1"
)
if not defined HAVEBASH (
    echo [install] winget didn't deliver Git - downloading PortableGit...
    set "GITROOT=%LOCALAPPDATA%\LocalAgentX"
    set "GITASSET=PortableGit-%GIT_PORTABLE_VERSION%-64-bit.7z.exe"
    :: The SFX extracts to its-own-dir\PortableGit (it ignores -o + the working
    :: dir), so it MUST sit in GITROOT for the output to land at GITDIR.
    if not exist "!GITROOT!" mkdir "!GITROOT!"
    set "GITSFX=!GITROOT!\!GITASSET!"
    set "GITURL=https://github.com/git-for-windows/git/releases/download/v%GIT_PORTABLE_VERSION%.windows.1/!GITASSET!"
    powershell -NoProfile -Command "Invoke-WebRequest -Uri '!GITURL!' -OutFile '!GITSFX!' -UseBasicParsing"
    set "GITHASH="
    for /f "skip=1 delims=" %%H in ('certutil -hashfile "!GITSFX!" SHA256') do if not defined GITHASH set "GITHASH=%%H"
    set "GITHASH=!GITHASH: =!"
    if /I not "!GITHASH!"=="%GIT_PORTABLE_SHA256%" (
        echo ERROR: PortableGit checksum mismatch ^(got !GITHASH!^) - refusing to extract.
        del "!GITSFX!" >nul 2>&1
        exit /b 1
    )
    if exist "%GITDIR%" rmdir /s /q "%GITDIR%"
    :: 7-Zip SFX (NOT a zip): -y assume-yes, -gm2 GUI hidden, -nr no auto-run.
    :: `start "" /wait` blocks until extraction finishes (GUI-subsystem exe).
    start "" /wait "!GITSFX!" -y -gm2 -nr
    del "!GITSFX!" >nul 2>&1
    set "PATH=%GITDIR%\cmd;%GITDIR%\bin;%PATH%"
    :: Persist via the Environment API (NOT setx — setx truncates PATH at 1024 chars).
    powershell -NoProfile -Command "$p=[Environment]::GetEnvironmentVariable('PATH','User'); foreach($d in @('%GITDIR%\cmd','%GITDIR%\bin')){ if($p -notlike ('*'+$d+'*')){$p=$d+';'+$p} }; [Environment]::SetEnvironmentVariable('PATH',$p,'User')"
)

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
