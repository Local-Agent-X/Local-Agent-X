# Studio-Vox tier VoxCPM sidecar installer.
#
# OpenBMB's VoxCPM2 - primary voice-clone engine (won the 2026-07 listening
# bake-off against Chatterbox). Zero-shot cloning from a 10-30s reference
# clip; LoRA fine-tuning available upstream for maximum-fidelity voices.
# Lives in its own venv to avoid torch conflicts with the other sidecars.
#
# Prerequisites:
#   * Python 3.12 (winget install Python.Python.3.12)
#   * CUDA-capable GPU with 8 GB+ VRAM recommended
#   * ~7 GB free disk (venv + model weights on first run)

$ErrorActionPreference = "Stop"
$venvDir = "$env:USERPROFILE\.lax\python-voxcpm\venv"

# 1) Locate Python 3.12+
$pythonExe = $null
foreach ($cmd in @("py -3.12", "py -3.13", "python3.12", "python3.13")) {
    try {
        $parts = $cmd.Split()
        $ver = & $parts[0] $parts[1..($parts.Length - 1)] --version 2>$null
        if ($ver -match "Python 3\.(12|13)") { $pythonExe = $cmd; break }
    } catch {}
}
if (-not $pythonExe) {
    Write-Error "Python 3.12 or 3.13 not found. Install with: winget install Python.Python.3.12"
}
Write-Host "Using $pythonExe"

# 2) Create venv if missing
if (-not (Test-Path "$venvDir\Scripts\python.exe")) {
    Write-Host "Creating venv at $venvDir ..."
    Invoke-Expression "$pythonExe -m venv `"$venvDir`""
}
$pyExe = "$venvDir\Scripts\python.exe"

# 3) pip + setuptools (py3.12 venvs ship without setuptools; audio deps
#    still import pkg_resources)
Write-Host "Upgrading pip + setuptools ..."
& $pyExe -m pip install --upgrade pip setuptools
if ($LASTEXITCODE -ne 0) { Write-Error "pip/setuptools upgrade failed (exit $LASTEXITCODE)" }

# 4) voxcpm + server deps + faster-whisper (auto-transcribes reference clips
#    at registration; VoxCPM conditions on the transcript)
Write-Host "Installing voxcpm + server deps ..."
& $pyExe -m pip install voxcpm faster-whisper fastapi "uvicorn[standard]" soundfile
if ($LASTEXITCODE -ne 0) { Write-Error "voxcpm install failed (exit $LASTEXITCODE)" }

# 5) Force the CUDA 12.8 torch AFTER everything else. Blackwell GPUs
#    (RTX 50-series, sm_120) need cu128 builds. --force-reinstall, not
#    --upgrade: PyPI's torch can be NEWER than the cu128 index's latest
#    (e.g. 2.13.0 cpu vs 2.11.0+cu128), and --upgrade won't downgrade --
#    that left a torch/torchaudio version mismatch where libtorchaudio.pyd
#    refused to load. Force-reinstall always lands the matched pair from
#    the CUDA index. Skipped on CI (LAX_FORCE_CPU_TORCH=1, no GPU).
if ($env:LAX_FORCE_CPU_TORCH -ne "1") {
    Write-Host "Installing CUDA 12.8 torch build (~3 GB) ..."
    & $pyExe -m pip install --force-reinstall torch torchaudio --index-url https://download.pytorch.org/whl/cu128
    if ($LASTEXITCODE -ne 0) { Write-Error "CUDA torch override failed (exit $LASTEXITCODE)" }
}

# 6) Sanity check - MUST fail the script on a bad import (PowerShell 5.1
#    ignores native exit codes under ErrorActionPreference=Stop).
Write-Host "Verifying install ..."
& $pyExe -c "import voxcpm; print('voxcpm: OK')"
if ($LASTEXITCODE -ne 0) { Write-Error "verify failed: 'import voxcpm' does not work; the venv is NOT usable" }
& $pyExe -c "import faster_whisper, fastapi, soundfile; print('server deps: OK')"
if ($LASTEXITCODE -ne 0) { Write-Error "verify failed: server deps do not import; the venv is NOT usable" }
& $pyExe -c "import torch; print('torch:', torch.__version__, 'cuda:', torch.cuda.is_available())"
if ($LASTEXITCODE -ne 0) { Write-Error "verify failed: 'import torch' does not work; the venv is NOT usable" }

Write-Host ""
Write-Host "Studio-Vox tier installed. Start the VoxCPM sidecar with:"
Write-Host "  $pyExe python/voxcpm/server.py"
