# Local Agent X — Windows PowerShell installer (thin wrapper).
# Cross-OS install logic lives in scripts/install-common.mjs.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Node 22+ (OS-specific bootstrap)
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

# Ollama (OS-specific bootstrap; install-common pulls the model)
if (-not (Has ollama)) {
  Write-Host "[install] Installing Ollama…"
  if (Has winget) { winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements -h }
  $env:PATH = "$env:LOCALAPPDATA\Programs\Ollama;$env:PATH"
}

& node scripts/install-common.mjs
