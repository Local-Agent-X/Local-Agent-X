# Studio tier Chatterbox sidecar installer.
#
# Resemble AI's Chatterbox (chatterbox-streaming variant) — single-stage
# TTS with reference-clip voice cloning, sub-200ms first-audio on a 3060,
# beats ElevenLabs in blind tests. Lives in its own venv to avoid torch
# version conflicts with the Lite voice sidecar (cu121) and the RVC
# sidecar (cu128).
#
# Prerequisites:
#   * Python 3.12 (winget install Python.Python.3.12)
#   * CUDA-capable GPU with 6 GB+ VRAM (8 GB+ comfortable)
#   * ~6 GB free disk

$ErrorActionPreference = "Stop"
$venvDir = "$env:USERPROFILE\.lax\python-chatterbox\venv"

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

# 3) Upgrade pip
Write-Host "Upgrading pip ..."
& $pyExe -m pip install --upgrade pip

# 4) Install chatterbox-streaming with CUDA 12.8 wheels
Write-Host "Installing chatterbox-streaming (~3 GB of torch wheels) ..."
& $pyExe -m pip install chatterbox-streaming --extra-index-url https://download.pytorch.org/whl/cu128

# 5) FastAPI runtime + audio helpers (most likely already pulled in by chatterbox)
& $pyExe -m pip install fastapi "uvicorn[standard]" soundfile

# 6) Sanity check
Write-Host "Verifying install ..."
& $pyExe -c "import chatterbox; print('chatterbox: OK')"
& $pyExe -c "import torch; print('torch:', torch.__version__, 'cuda:', torch.cuda.is_available())"

Write-Host ""
Write-Host "Studio tier installed. Start the Chatterbox sidecar with:"
Write-Host "  $pyExe python/chatterbox/server.py"
