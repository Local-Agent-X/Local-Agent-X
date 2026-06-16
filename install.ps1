# Local Agent X — Windows PowerShell installer (thin wrapper).
# GUI installer is the preferred path — see Install Local Agent X Windows
# Installer.exe at the repo root. This wrapper exists for CLI users.
#
# Bootstrap is minimal: ensure Node is present (chicken-and-egg, since
# install-common.mjs needs Node to run), then hand off. All other install
# steps (VS Build Tools, Python, Ollama, npm install, model pull, build,
# shortcuts) now live in scripts/install-common.mjs so a single source of
# truth covers both CLI and GUI flows.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Node 22+ (OS-specific bootstrap — must run BEFORE install-common.mjs).
$nodeOk = (Has node) -and ([int]((& node -v).TrimStart('v').Split('.')[0]) -ge 22)
if (-not $nodeOk) {
  Write-Host "[install] Installing Node 24 (LTS)…"
  if (Has winget) {
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements -h
    $env:PATH = "$env:ProgramFiles\nodejs;$env:PATH"
  } else {
    # No winget: unpack the portable Node zip to a per-user dir. No admin and
    # no msiexec — the MSI path needed elevation this script doesn't request.
    $ver = "24.16.0"
    $zip = "$env:TEMP\node-v$ver-win-x64.zip"
    $root = "$env:LOCALAPPDATA\LocalAgentX"
    $nodeDir = "$root\node-v$ver-win-x64"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$ver/node-v$ver-win-x64.zip" -OutFile $zip -UseBasicParsing
    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Expand-Archive -Path $zip -DestinationPath $root -Force
    Remove-Item $zip -ErrorAction SilentlyContinue
    $env:PATH = "$nodeDir;$env:PATH"
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$nodeDir*") {
      [Environment]::SetEnvironmentVariable("PATH", "$userPath;$nodeDir", "User")
    }
  }
}

& node scripts/install-common.mjs @args
