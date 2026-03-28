# ═══════════════════════════════════════════════════════════
#  OPEN AGENT X — One-Click Installer (PowerShell)
# ═══════════════════════════════════════════════════════════
#
#  Run with:
#    iwr -useb https://raw.githubusercontent.com/petermanrique101-sys/Open-Agent-X/main/install.ps1 | iex
#
#  Or save and run:
#    .\install.ps1
#

$ErrorActionPreference = "Stop"
$InstallDir = "$env:USERPROFILE\Open-Agent-X"

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "    OPEN AGENT X - One-Click Installer" -ForegroundColor Green
Write-Host ""
Write-Host "    Your personal AI agent — runs locally, 100% private." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  ================================================================" -ForegroundColor Green
Write-Host ""

# ── Step 1: Check Node.js ──
Write-Host "  [1/6] Checking for Node.js..." -ForegroundColor Cyan

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  Node.js not found. Installing..." -ForegroundColor Yellow
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements -h
        $env:PATH = "$env:ProgramFiles\nodejs;$env:PATH"
    } else {
        Write-Host "  Downloading Node.js..." -ForegroundColor Yellow
        $nodeUrl = "https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi"
        $nodeMsi = "$env:TEMP\node-installer.msi"
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
        Start-Process msiexec -ArgumentList "/i `"$nodeMsi`" /qn" -Wait
        $env:PATH = "$env:ProgramFiles\nodejs;$env:PATH"
        Remove-Item $nodeMsi -ErrorAction SilentlyContinue
    }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  ERROR: Node.js installation failed." -ForegroundColor Red
    Write-Host "  Install Node.js 22+ from https://nodejs.org and try again." -ForegroundColor Red
    exit 1
}

$nodeVer = & node --version
Write-Host "  Found Node.js $nodeVer" -ForegroundColor Green

# ── Step 2: Check Git ──
Write-Host "  [2/6] Checking for Git..." -ForegroundColor Cyan

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Write-Host "  Git not found. Installing..." -ForegroundColor Yellow
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        winget install Git.Git --accept-package-agreements --accept-source-agreements -h
        $env:PATH = "$env:ProgramFiles\Git\cmd;$env:PATH"
    }
}

$hasGit = $null -ne (Get-Command git -ErrorAction SilentlyContinue)

# ── Step 3: Download ──
Write-Host "  [3/6] Downloading Open Agent X..." -ForegroundColor Cyan

if (Test-Path "$InstallDir\package.json") {
    Write-Host "  Found existing installation. Updating..." -ForegroundColor Yellow
    Set-Location $InstallDir
    if ($hasGit) { git pull origin main 2>$null }
} elseif ($hasGit) {
    Write-Host "  Cloning repository..." -ForegroundColor DarkGray
    git clone https://github.com/petermanrique101-sys/Open-Agent-X.git $InstallDir
    Set-Location $InstallDir
} else {
    Write-Host "  Downloading ZIP..." -ForegroundColor DarkGray
    $zipUrl = "https://github.com/petermanrique101-sys/Open-Agent-X/archive/refs/heads/main.zip"
    $zipFile = "$env:TEMP\open-agent-x.zip"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing
    Expand-Archive -Path $zipFile -DestinationPath "$env:TEMP\oax-extract" -Force
    $extractDir = Get-ChildItem "$env:TEMP\oax-extract" -Directory | Select-Object -First 1
    Move-Item $extractDir.FullName $InstallDir
    Remove-Item $zipFile -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\oax-extract" -Recurse -ErrorAction SilentlyContinue
    Set-Location $InstallDir
}

# ── Step 4: Install dependencies ──
Write-Host "  [4/6] Installing dependencies..." -ForegroundColor Cyan

npm install --no-audit --no-fund 2>$null
if ($LASTEXITCODE -ne 0) {
    npm install --no-audit --no-fund --legacy-peer-deps 2>$null
}

# Install Playwright
Write-Host "  Installing browser automation..." -ForegroundColor DarkGray
npx playwright install chromium 2>$null

# ── Step 5: Build ──
Write-Host "  [5/6] Building..." -ForegroundColor Cyan

npm run build 2>$null

if (-not (Test-Path "dist\index.js")) {
    Write-Host "  ERROR: Build failed." -ForegroundColor Red
    exit 1
}

# ── Step 6: Create shortcuts ──
Write-Host "  [6/6] Creating shortcuts..." -ForegroundColor Cyan

# Create start script
@"
@echo off
title Open Agent X
cd /d "$InstallDir"
echo Starting Open Agent X...
node --max-old-space-size=512 dist/index.js
pause
"@ | Set-Content "$InstallDir\start.bat"

# Desktop shortcut
$desktop = [Environment]::GetFolderPath("Desktop")
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut("$desktop\Open Agent X.lnk")
$sc.TargetPath = "$InstallDir\start.bat"
$sc.WorkingDirectory = $InstallDir
$sc.Description = "Open Agent X - Personal AI Agent"
$sc.Save()

# Start Menu shortcut
$startMenu = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
$sc2 = $ws.CreateShortcut("$startMenu\Open Agent X.lnk")
$sc2.TargetPath = "$InstallDir\start.bat"
$sc2.WorkingDirectory = $InstallDir
$sc2.Description = "Open Agent X - Personal AI Agent"
$sc2.Save()

Write-Host "  Desktop shortcut created." -ForegroundColor Green

# ── Launch ──
Write-Host ""
Write-Host "  ================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "    Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "    Installed at: $InstallDir" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    To start anytime:" -ForegroundColor DarkGray
Write-Host "      - Double-click 'Open Agent X' on your desktop" -ForegroundColor DarkGray
Write-Host "      - Or: cd $InstallDir && npm start" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  ================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Starting Open Agent X..." -ForegroundColor Cyan

Start-Process cmd -ArgumentList "/c `"cd /d `"$InstallDir`" && node --max-old-space-size=512 dist/index.js`"" -WindowStyle Normal

Start-Sleep -Seconds 5

# Open browser
Start-Process "http://127.0.0.1:7007"

Write-Host ""
Write-Host "  Open Agent X is running! Check your browser." -ForegroundColor Green
Write-Host "  Press Enter to close this installer." -ForegroundColor DarkGray
Read-Host
