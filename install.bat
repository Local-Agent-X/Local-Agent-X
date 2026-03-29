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
echo    Your personal AI agent - runs locally, 100%% private.
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

if exist "%INSTALL_DIR%\package.json" goto :existing_install
goto :fresh_download

:existing_install
echo  Found existing installation at %INSTALL_DIR%
echo  Updating...
cd /d "%INSTALL_DIR%"
where git >nul 2>&1 && git pull origin main 2>nul
goto :install_deps

:fresh_download
:: Download via PowerShell (most reliable across all Windows setups)
cd /d "%USERPROFILE%"
echo.
echo  Downloading from GitHub (ZIP)...
set "ZIP_URL=https://github.com/petermanrique101-sys/Open-Agent-X/archive/refs/heads/main.zip"
set "ZIP_FILE=%TEMP%\open-agent-x.zip"
powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%ZIP_URL%' -OutFile '%ZIP_FILE%' -UseBasicParsing"
if not exist "%ZIP_FILE%" (
    echo.
    echo  ERROR: Could not download Open Agent X.
    echo  Check your internet connection and try again.
    pause
    exit /b 1
)
echo  Extracting...
powershell -Command "Expand-Archive -Path '%ZIP_FILE%' -DestinationPath '%TEMP%\oax-extract' -Force"
if exist "%TEMP%\oax-extract\Open-Agent-X-main" (
    move "%TEMP%\oax-extract\Open-Agent-X-main" "%INSTALL_DIR%" >nul 2>&1
) else (
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

:: CRITICAL: Verify we're in the right directory before running npm
cd /d "%INSTALL_DIR%" 2>nul
if not exist "%INSTALL_DIR%\package.json" (
    echo.
    echo  ERROR: Download failed - package.json not found in %INSTALL_DIR%
    echo  The repository may not have downloaded correctly.
    echo  Try deleting %INSTALL_DIR% and running the installer again.
    echo.
    pause
    exit /b 1
)
echo.
echo  [4/6] Installing dependencies (this may take a minute)...

call npm install --no-audit --no-fund
if %errorlevel% neq 0 goto :npm_retry
goto :npm_done

:npm_retry
echo  First attempt failed. Retrying with legacy peer deps...
call npm install --no-audit --no-fund --legacy-peer-deps
if %errorlevel% neq 0 goto :npm_failed
goto :npm_done

:npm_failed
echo.
echo  ERROR: Could not install dependencies.
echo  Check the error messages above and try again.
pause
exit /b 1

:npm_done

:: Install Playwright browsers (optional - for browser automation)
echo.
echo  Installing browser automation (this may take a minute)...
call npx --yes playwright install chromium 2>nul
echo  Browser automation setup complete.

:: ── Step 5: Build ──
echo.
echo  [5/6] Building Open Agent X...

call npm run build
if %errorlevel% neq 0 goto :build_failed
if not exist "dist\index.js" goto :build_failed

:: Build desktop app (Electron wrapper)
echo  Building desktop app...
cd /d "%INSTALL_DIR%\desktop"
call npm install --no-audit --no-fund 2>nul
call npx tsc 2>nul
cd /d "%INSTALL_DIR%"
goto :build_done

:build_failed
echo.
echo  ERROR: Build failed. See errors above.
echo  Try running manually: cd "%INSTALL_DIR%" ^&^& npm run build
pause
exit /b 1

:build_done

:: ── Step 6: Create shortcuts and start ──
echo.
echo  [6/6] Creating shortcuts...

:: Create a VBS launcher (starts Electron without any visible cmd window)
set "ICON_PATH=%INSTALL_DIR%\public\icon.ico"
set "ELECTRON_CMD=%INSTALL_DIR%\desktop\node_modules\.bin\electron.cmd"
powershell -Command "Set-Content -Path '%INSTALL_DIR%\launch.vbs' -Value \"Set WshShell = CreateObject(`\"WScript.Shell`\")`r`nWshShell.CurrentDirectory = `\"%INSTALL_DIR%\desktop`\"`r`nWshShell.Run `\"`\"`\"%ELECTRON_CMD%`\"`\" dist/main.js`\", 0, False\"" 2>nul

:: Create start.bat as fallback (calls the VBS)
powershell -Command "Set-Content -Path '%INSTALL_DIR%\start.bat' -Value \"@echo off`r`ncscript //nologo `\"%INSTALL_DIR%\launch.vbs`\"`r`nexit\"" 2>nul

:: Also keep a start-server.bat for debug
powershell -Command "Set-Content -Path '%INSTALL_DIR%\start-server.bat' -Value \"@echo off`r`ntitle Open Agent X Server`r`ncd /d %INSTALL_DIR%`r`nnode --max-old-space-size=512 dist/index.js`r`npause\"" 2>nul

:: Create desktop shortcut (handles OneDrive Desktop path)
powershell -Command "$desktop=[Environment]::GetFolderPath('Desktop'); $ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut(\"$desktop\Open Agent X.lnk\"); $sc.TargetPath='%INSTALL_DIR%\start.bat'; $sc.WorkingDirectory='%INSTALL_DIR%\desktop'; $sc.Description='Open Agent X'; if(Test-Path '%ICON_PATH%'){$sc.IconLocation='%ICON_PATH%,0'}; $sc.Save(); Write-Host '  Desktop shortcut created.'" 2>nul

:: Create Start Menu shortcut
powershell -Command "$sm=\"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\"; $ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut(\"${sm}Open Agent X.lnk\"); $sc.TargetPath='%INSTALL_DIR%\start.bat'; $sc.WorkingDirectory='%INSTALL_DIR%\desktop'; $sc.Description='Open Agent X'; if(Test-Path '%ICON_PATH%'){$sc.IconLocation='%ICON_PATH%,0'}; $sc.Save()" 2>nul

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
echo.
echo  ================================================================
echo.
echo  Starting Open Agent X now...
echo.

:: Launch the Electron desktop app (starts server + opens UI automatically)
cscript //nologo "%INSTALL_DIR%\launch.vbs"

echo.
echo  Open Agent X is running! Check your browser.
echo  Press any key to close this installer (the server keeps running).
echo.
pause
exit /b 0
