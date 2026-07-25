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
# CUDA 12.8 torch pair, pinned to the versions verified on the RTX 5090 box.
# Not in requirements.txt: +cu128 is a local version that only exists on the
# pytorch index and has no macOS wheel, so it would break install.sh.
# PowerShell splats an array into separate native-command arguments.
$TorchPin = @("torch==2.11.0+cu128", "torchaudio==2.11.0+cu128")

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

# 3) Bootstrap uv into the venv, then use it as the installer. uv is a single
#    dependency-free wheel; it resolves the whole graph and downloads every
#    wheel BEFORE installing anything, so a failed resolve can no longer leave a
#    half-built venv, and it is far faster than pip on the ~3 GB torch wheels
#    below. setuptools is still installed into the venv - librosa needs
#    pkg_resources, and Python 3.12 venvs no longer ship setuptools by default.
Write-Host "Bootstrapping uv ..."
& $pyExe -m pip install --upgrade uv --quiet
if ($LASTEXITCODE -ne 0) { Write-Error "uv bootstrap failed (exit $LASTEXITCODE)" }
$uvExe = Join-Path $venvDir "Scripts\uv.exe"
$reqs = Join-Path $PSScriptRoot "requirements.txt"

# 4) Install the pinned base FIRST (setuptools + chatterbox-streaming + the
#    FastAPI/audio runtime; see requirements.txt). chatterbox-streaming hard-pins
#    torch==2.6.0, and no CUDA-12.8 wheel exists for 2.6.0 - so on this step the
#    CPU torch lands no matter which index we point at. The torch override in
#    step 5 is what fixes that, and it MUST run after this.
Write-Host "Installing pinned base (chatterbox-streaming + server deps) ..."
# --index-strategy unsafe-best-match makes uv consider both PyPI and the cu128
# index like pip does; without it uv stops at the first index that has a package.
& $uvExe pip install --python $pyExe -r $reqs --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match
if ($LASTEXITCODE -ne 0) { Write-Error "pinned base install failed (exit $LASTEXITCODE)" }

# 5) THEN force the CUDA torch over the pin. Blackwell GPUs (RTX 50-series,
#    sm_120) need torch>=2.7 cu128; chatterbox works fine on newer torch —
#    the ==2.6.0 pin is upstream conservatism, and pip's resolver warning
#    about it is expected and harmless here. Order matters: torch must be
#    installed AFTER chatterbox so the CUDA build wins. Skipped on CI
#    (LAX_FORCE_CPU_TORCH=1, no GPU on runners) where the pinned CPU torch
#    is exactly right.
if ($env:LAX_FORCE_CPU_TORCH -ne "1") {
    Write-Host "Overriding torch with CUDA 12.8 build (~3 GB; upstream pin lags Blackwell) ..."
    # --reinstall (uv's --force-reinstall), not --upgrade: PyPI's torch can be
    # NEWER than the cu128 index's latest, and --upgrade won't downgrade —
    # leaving a torch/torchaudio mismatch. Reinstall lands the matched pair.
    # Pinned rather than floating so a cu128 index bump can't silently swap the
    # torch under a working install; $TorchPin is the pair verified on the 5090.
    & $uvExe pip install --python $pyExe --reinstall $TorchPin --index-url https://download.pytorch.org/whl/cu128
    if ($LASTEXITCODE -ne 0) { Write-Error "CUDA torch override failed (exit $LASTEXITCODE)" }
}

# 7) Sanity check. MUST fail the script on a bad import: PowerShell 5.1 does
#    not stop on a native command's non-zero exit even with
#    ErrorActionPreference=Stop, and this installer once printed "Studio tier
#    installed" over a venv whose `import chatterbox` had just tracebacked.
Write-Host "Verifying install ..."
& $pyExe -c "import chatterbox; print('chatterbox: OK')"
if ($LASTEXITCODE -ne 0) { Write-Error "verify failed: 'import chatterbox' does not work; the venv is NOT usable" }
& $pyExe -c "import torch; print('torch:', torch.__version__, 'cuda:', torch.cuda.is_available())"
if ($LASTEXITCODE -ne 0) { Write-Error "verify failed: 'import torch' does not work; the venv is NOT usable" }

Write-Host ""
Write-Host "Studio tier installed. Start the Chatterbox sidecar with:"
Write-Host "  $pyExe python/chatterbox/server.py"
