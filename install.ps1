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

# Visual Studio Build Tools (C++ workload). Required when an npm dependency
# lacks a prebuilt binary for the current Node ABI and falls back to source
# compile (better-sqlite3, @napi-rs/canvas, sqlite-vec etc all have prebuilds
# but newer Node versions can outpace them). Detect via vswhere; if absent,
# install the BuildTools with only the VC tools workload (~3 GB, not the
# full VS IDE).
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$hasVcTools = $false
if (Test-Path $vswhere) {
  $found = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if ($found) { $hasVcTools = $true }
}
if (-not $hasVcTools) {
  Write-Host "[install] Installing Visual Studio Build Tools (C++ workload, ~3 GB, one-time)…"
  if (Has winget) {
    winget install --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements --silent --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  } else {
    Write-Host "[install] winget unavailable — install VS Build Tools (C++ workload) manually: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
  }
}

# Python 3.12. Not required for the default chat/build flow, but used by the
# optional voice servers (chatterbox/sovits/xtts) and by some user scripts.
# Bundling it up-front avoids a separate prompt later.
if (-not (Has python)) {
  Write-Host "[install] Installing Python 3.12…"
  if (Has winget) { winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements -h }
  $env:PATH = "$env:LOCALAPPDATA\Programs\Python\Python312;$env:PATH"
}

# Ollama (OS-specific bootstrap; install-common pulls the model)
if (-not (Has ollama)) {
  Write-Host "[install] Installing Ollama…"
  if (Has winget) { winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements -h }
  $env:PATH = "$env:LOCALAPPDATA\Programs\Ollama;$env:PATH"
}

& node scripts/install-common.mjs
