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
    # Match the host CPU — win-x64 node.exe won't run natively on Windows on ARM.
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
    $pkg = "node-v$ver-$arch"
    $zip = "$env:TEMP\$pkg.zip"
    $root = "$env:LOCALAPPDATA\LocalAgentX"
    $nodeDir = "$root\$pkg"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$ver/$pkg.zip" -OutFile $zip -UseBasicParsing
    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Expand-Archive -Path $zip -DestinationPath $root -Force
    Remove-Item $zip -ErrorAction SilentlyContinue
    $env:PATH = "$nodeDir;$env:PATH"
    # Prepend (not append) to the persisted user PATH so this node wins over any
    # older system node at runtime — otherwise the desktop node-floor gate trips.
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$nodeDir*") {
      [Environment]::SetEnvironmentVariable("PATH", "$nodeDir;$userPath", "User")
    }
  }
}

& node scripts/install-common.mjs @args
