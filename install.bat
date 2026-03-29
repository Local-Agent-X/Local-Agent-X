@echo off
setlocal enabledelayedexpansion
title Open Agent X - Installer
color 0A

:: ═══════════════════════════════════════════════════════════
::  OPEN AGENT X — One-Click Installer for Windows
:: ═══════════════════════════════════════════════════════════
::
::  Downloads, installs, and launches Open Agent X.
::  No technical knowledge required.
::
::  What this does:
::    1. Checks for Node.js (installs if missing)
::    2. Downloads Open Agent X from GitHub
::    3. Installs dependencies
::    4. Builds the project
::    5. Creates a desktop shortcut
::    6. Starts the server and opens your browser
::

echo.
echo  ================================================================
echo.
echo    OPEN AGENT X - One-Click Installer
echo.
echo    Your personal AI agent — runs locally, 100%% private.
echo.
echo  ================================================================
echo.
echo  This will install Open Agent X on your computer.
echo  Installation takes 2-5 minutes depending on your connection.
echo.
pause

:: ── Step 0: Check for admin rights (needed for Node.js install) ──
net session >nul 2>&1
set "IS_ADMIN=%errorlevel%"

:: ── Step 1: Check for Node.js ──
echo.
echo  [1/6] Checking for Node.js...

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  Node.js not found. Installing...
    echo.

    :: Try winget first (Windows 10/11)
    where winget >nul 2>&1
    if !errorlevel! equ 0 (
        echo  Installing Node.js via winget...
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements -h
        if !errorlevel! equ 0 (
            echo  Node.js installed successfully.
            :: Refresh PATH
            set "PATH=%ProgramFiles%\nodejs;%PATH%"
        ) else (
            goto :install_node_manual
        )
    ) else (
        goto :install_node_manual
    )
) else (
    for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
    echo  Found Node.js !NODE_VER!

    :: Check version >= 22
    for /f "tokens=1 delims=v." %%a in ("!NODE_VER!") do set NODE_MRileyOR=%%a
    if !NODE_MRileyOR! LSS 22 (
        echo.
        echo  WARNING: Node.js 22+ is required. You have !NODE_VER!.
        echo  Updating Node.js...
        where winget >nul 2>&1
        if !errorlevel! equ 0 (
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements -h
            set "PATH=%ProgramFiles%\nodejs;%PATH%"
        ) else (
            goto :install_node_manual
        )
    )
)

:: Verify node works
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Node.js installation failed.
    echo  Please install Node.js 22+ manually from https://nodejs.org
    echo  Then run this installer again.
    pause
    exit /b 1
)

goto :check_git

:install_node_manual
echo.
echo  Downloading Node.js installer...
set "NODE_URL=https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi"
set "NODE_MSI=%TEMP%\node-installer.msi"
powershell -Command "Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_MSI%'" 2>nul
if exist "%NODE_MSI%" (
    echo  Running Node.js installer (this may ask for admin permission)...
    msiexec /i "%NODE_MSI%" /qn
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    del "%NODE_MSI%" 2>nul
) else (
    echo.
    echo  ERROR: Could not download Node.js.
    echo  Please install manually from https://nodejs.org
    pause
    exit /b 1
)
goto :check_git

:: ── Step 2: Check for Git ──
:check_git
echo.
echo  [2/6] Checking for Git...

where git >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  Git not found. Installing...
    where winget >nul 2>&1
    if !errorlevel! equ 0 (
        winget install Git.Git --accept-package-agreements --accept-source-agreements -h
        set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
    ) else (
        echo.
        echo  Downloading Git installer...
        set "GIT_URL=https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe"
        set "GIT_EXE=%TEMP%\git-installer.exe"
        powershell -Command "Invoke-WebRequest -Uri '%GIT_URL%' -OutFile '%GIT_EXE%'" 2>nul
        if exist "!GIT_EXE!" (
            echo  Running Git installer...
            "!GIT_EXE!" /VERYSILENT /NORESTART
            set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
            del "!GIT_EXE!" 2>nul
        ) else (
            echo  WARNING: Could not install Git. Will download as ZIP instead.
        )
    )
)

where git >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('git --version') do echo  Found %%v
    set "HAS_GIT=1"
) else (
    set "HAS_GIT=0"
)

:: ── Step 3: Download Open Agent X ──
echo.
echo  [3/6] Downloading Open Agent X...

set "INSTALL_DIR=%USERPROFILE%\Open-Agent-X"

if exist "%INSTALL_DIR%\package.json" (
    echo  Found existing installation at %INSTALL_DIR%
    echo  Updating...
    cd /d "%INSTALL_DIR%"
    if "%HAS_GIT%"=="1" (
        git pull origin main 2>nul || echo  (pull skipped - may be a zip install)
    )
    goto :install_deps
)

if "%HAS_GIT%"=="1" (
    echo  Cloning repository...
    git clone https://github.com/petermanrique101-sys/Open-Agent-X.git "%INSTALL_DIR%" 2>nul
    if !errorlevel! neq 0 (
        echo  Git clone failed. Trying ZIP download...
        goto :download_zip
    )
    cd /d "%INSTALL_DIR%"
) else (
    goto :download_zip
)
goto :install_deps

:download_zip
echo  Downloading ZIP archive...
set "ZIP_URL=https://github.com/petermanrique101-sys/Open-Agent-X/archive/refs/heads/main.zip"
set "ZIP_FILE=%TEMP%\open-agent-x.zip"
powershell -Command "Invoke-WebRequest -Uri '%ZIP_URL%' -OutFile '%ZIP_FILE%'" 2>nul
if not exist "%ZIP_FILE%" (
    echo.
    echo  ERROR: Could not download Open Agent X.
    echo  Check your internet connection and try again.
    pause
    exit /b 1
)
echo  Extracting...
powershell -Command "Expand-Archive -Path '%ZIP_FILE%' -DestinationPath '%TEMP%\oax-extract' -Force" 2>nul
:: The zip extracts to a subfolder
if exist "%TEMP%\oax-extract\Open-Agent-X-main" (
    move "%TEMP%\oax-extract\Open-Agent-X-main" "%INSTALL_DIR%" >nul 2>&1
) else (
    :: Try other possible folder names
    for /d %%d in ("%TEMP%\oax-extract\*") do (
        move "%%d" "%INSTALL_DIR%" >nul 2>&1
        goto :zip_moved
    )
)
:zip_moved
del "%ZIP_FILE%" 2>nul
rmdir /s /q "%TEMP%\oax-extract" 2>nul
cd /d "%INSTALL_DIR%"

:: ── Step 4: Install dependencies ──
:install_deps
echo.
echo  [4/6] Installing dependencies (this may take a minute)...

call npm install --no-audit --no-fund 2>nul
if %errorlevel% neq 0 (
    echo  Retrying with legacy peer deps...
    call npm install --no-audit --no-fund --legacy-peer-deps 2>nul
)

:: Install Playwright browsers (for browser automation)
echo  Installing browser automation...
npx playwright install chromium 2>nul

:: ── Step 5: Build ──
echo.
echo  [5/6] Building Open Agent X...

call npm run build 2>nul
if %errorlevel% neq 0 (
    echo  Build had warnings (this is usually fine).
)

:: Verify build output exists
if not exist "dist\index.js" (
    echo.
    echo  ERROR: Build failed. dist\index.js not found.
    echo  Try running manually: cd "%INSTALL_DIR%" ^&^& npm run build
    pause
    exit /b 1
)

:: ── Step 6: Create shortcuts and start ──
echo.
echo  [6/6] Creating shortcuts...

:: Create start script
(
echo @echo off
echo title Open Agent X
echo cd /d "%INSTALL_DIR%"
echo echo Starting Open Agent X...
echo node --max-old-space-size=512 dist/index.js
echo pause
) > "%INSTALL_DIR%\start.bat"

:: Create desktop shortcut via PowerShell (with custom icon)
set "SHORTCUT=%USERPROFILE%\Desktop\Open Agent X.lnk"
set "ICON_PATH=%INSTALL_DIR%\public\icon.ico"
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%SHORTCUT%'); $sc.TargetPath = '%INSTALL_DIR%\start.bat'; $sc.WorkingDirectory = '%INSTALL_DIR%'; $sc.Description = 'Open Agent X - Personal AI Agent'; if (Test-Path '%ICON_PATH%') { $sc.IconLocation = '%ICON_PATH%,0' }; $sc.Save()" 2>nul

if exist "%SHORTCUT%" (
    echo  Desktop shortcut created.
) else (
    echo  Could not create shortcut (non-critical).
)

:: Create Start Menu shortcut (with custom icon)
set "START_MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
set "SM_SHORTCUT=%START_MENU%\Open Agent X.lnk"
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%SM_SHORTCUT%'); $sc.TargetPath = '%INSTALL_DIR%\start.bat'; $sc.WorkingDirectory = '%INSTALL_DIR%'; $sc.Description = 'Open Agent X - Personal AI Agent'; if (Test-Path '%ICON_PATH%') { $sc.IconLocation = '%ICON_PATH%,0' }; $sc.Save()" 2>nul

:: ── Launch ──
echo.
echo  ================================================================
echo.
echo    Installation complete!
echo.
echo    Open Agent X is installed at:
echo    %INSTALL_DIR%
echo.
echo    To start it anytime:
echo      - Double-click "Open Agent X" on your desktop
echo      - Or run: cd "%INSTALL_DIR%" ^&^& npm start
echo.
echo  ================================================================
echo.
echo  Starting Open Agent X now...
echo.

:: Start the server
cd /d "%INSTALL_DIR%"
start "Open Agent X" cmd /c "node --max-old-space-size=512 dist/index.js"

:: Wait for server to start, then open browser
timeout /t 5 /nobreak >nul

:: Read the auth token from output or config
for /f "tokens=*" %%u in ('node -e "try{const c=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.sax','config.json'),'utf-8'));console.log(c.authToken)}catch{}" 2^>nul') do set "AUTH_TOKEN=%%u"

if defined AUTH_TOKEN (
    start http://127.0.0.1:7007/?token=%AUTH_TOKEN%
) else (
    start http://127.0.0.1:7007
)

echo.
echo  Open Agent X is running! Check your browser.
echo  Press any key to close this installer (the server keeps running).
echo.
pause
exit /b 0
