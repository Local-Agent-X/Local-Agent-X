# Local Agent X - GPU voice sidecar installer (Windows / PowerShell 5.1+).
#
# Creates a Python venv at ~/.lax/python-voice/venv/, installs the CUDA-
# enabled wheels for faster-whisper + kokoro-onnx + onnxruntime-gpu, and
# downloads the Kokoro 82M model files.
#
# Usage from project root:
#   .\python\voice\install.ps1
#
# Footprint: ~3-4GB (CUDA libs + models). One-time setup; subsequent runs
# of the sidecar reuse the venv.

$ErrorActionPreference = "Stop"

$VenvDir = Join-Path $env:USERPROFILE ".lax\python-voice\venv"
$ModelsDir = Join-Path $env:USERPROFILE ".lax\python-voice\kokoro"
$Requirements = Join-Path $PSScriptRoot "requirements.txt"
$SmokeScript = Join-Path $PSScriptRoot "_smoke.py"

Write-Host ""
Write-Host "==> Local Agent X - GPU voice sidecar installer" -ForegroundColor Cyan
Write-Host "    venv:   $VenvDir"
Write-Host "    models: $ModelsDir"
Write-Host ""

# 1. Verify Python
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host "ERROR: python not on PATH. Install Python 3.11+ from python.org first." -ForegroundColor Red
    exit 1
}
$pyVersion = & python --version 2>&1
Write-Host "[1/5] $pyVersion"

# 2. Create venv
if (-not (Test-Path $VenvDir)) {
    Write-Host "[2/5] creating venv..."
    & python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { Write-Host "venv create failed" -ForegroundColor Red; exit 1 }
} else {
    Write-Host "[2/5] venv exists, reusing"
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip = Join-Path $VenvDir "Scripts\pip.exe"

# 3. Upgrade pip + install requirements
Write-Host "[3/5] upgrading pip..."
& $VenvPython -m pip install --upgrade pip --quiet

Write-Host "[4/5] installing GPU voice deps (slow part - ~2GB of CUDA wheels)..."
& $VenvPip install -r $Requirements
if ($LASTEXITCODE -ne 0) {
    Write-Host "pip install failed - check the output above" -ForegroundColor Red
    exit 1
}

# 4. Download Kokoro model files
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

$KokoroModel = Join-Path $ModelsDir "model.onnx"
$KokoroVoices = Join-Path $ModelsDir "voices.bin"

if (-not (Test-Path $KokoroModel)) {
    Write-Host "[5/5] downloading kokoro model.onnx (~310MB)..."
    Invoke-WebRequest -Uri "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx" -OutFile $KokoroModel -UseBasicParsing
} else {
    Write-Host "[5/5] kokoro model.onnx already present"
}

if (-not (Test-Path $KokoroVoices)) {
    Write-Host "      downloading kokoro voices.bin (~26MB)..."
    Invoke-WebRequest -Uri "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin" -OutFile $KokoroVoices -UseBasicParsing
} else {
    Write-Host "      kokoro voices.bin already present"
}

# 5. Verify-after-install. Runs the committed _smoke.py from the venv and
# FAILS the install if any critical module is missing. pip's exit code alone
# is not proof: a resolution error leaves the venv on disk with only pip in
# it, and the picker reads a bare venv as "Installed" - that gap is what let
# a failed install surface later as a ModuleNotFoundError crash on Start.
# Only an import proves the venv can run the sidecar.
#
# NOTE: keep this file pure ASCII. It has no BOM, so Windows PowerShell 5.1
# decodes it as Windows-1252, where a UTF-8 em-dash's trailing byte becomes a
# smart quote that PowerShell honors as a string terminator - one stray dash
# stops the whole script from parsing.
Write-Host ""
Write-Host "==> verifying venv (importing every critical module)..."
$smokeOut = & $VenvPython $SmokeScript 2>&1
$smokeExit = $LASTEXITCODE
Write-Host $smokeOut

if ($smokeExit -ne 0) {
    Write-Host ""
    Write-Host "==> Install FAILED - the venv is missing critical modules (see above)." -ForegroundColor Red
    Write-Host "    Nothing was left in a usable state; fix the error above and re-run."
    exit 1
}

if ($smokeOut -match "cuda: True") {
    Write-Host ""
    Write-Host "==> Install OK. CUDA detected." -ForegroundColor Green
    Write-Host "    Start the sidecar:"
    Write-Host "      $VenvPython python\voice\server.py"
} else {
    Write-Host ""
    Write-Host "==> Install OK, but CUDA was not detected." -ForegroundColor Yellow
    Write-Host "    Voice sidecar will fall back to CPU (slow). Check that:"
    Write-Host "      - NVIDIA driver supports CUDA 12.x (run nvidia-smi)"
    Write-Host "      - You haven't installed cpu-only onnxruntime on top of onnxruntime-gpu"
}
