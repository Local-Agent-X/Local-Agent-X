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
  Write-Host "[install] Installing Node 22…"
  if (Has winget) {
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements -h
  } else {
    $msi = "$env:TEMP\node-installer.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi" -OutFile $msi -UseBasicParsing
    Start-Process msiexec -ArgumentList "/i `"$msi`" /qn" -Wait
    Remove-Item $msi -ErrorAction SilentlyContinue
  }
  $env:PATH = "$env:ProgramFiles\nodejs;$env:PATH"
}

& node scripts/install-common.mjs @args
