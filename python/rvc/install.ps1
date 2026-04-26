# Pro tier RVC sidecar installer.
#
# Creates an isolated venv at ~/.lax/python-rvc/venv/ and installs
# ultimate-rvc with CUDA 12.8 wheels. Runs separately from the Lite
# voice sidecar (which uses torch+cu121) so the two stacks never fight
# over CUDA runtime libraries.
#
# Prerequisites:
#   * Python 3.12 (or 3.13) — install via `winget install Python.Python.3.12`
#   * CUDA-capable GPU with 12 GB+ VRAM (training) or 6 GB+ (inference)
#   * ~10 GB free disk for venv + base models

$ErrorActionPreference = "Stop"

$venvDir = "$env:USERPROFILE\.lax\python-rvc\venv"

# 1) Locate Python 3.12+
$pythonExe = $null
$candidates = @("py -3.12", "py -3.13", "python3.12", "python3.13")
foreach ($cmd in $candidates) {
    try {
        $ver = & $cmd.Split()[0] $cmd.Split()[1..($cmd.Split().Length - 1)] --version 2>$null
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

# 4) Install ultimate-rvc with CUDA 12.8 wheels
Write-Host "Installing ultimate-rvc[cuda] (this is the slow part — ~3 GB of torch wheels) ..."
& $pyExe -m pip install "ultimate-rvc[cuda]" --extra-index-url https://download.pytorch.org/whl/cu128

# 5) Sanity check
Write-Host "Verifying install ..."
& $pyExe -c "import ultimate_rvc; print('ultimate-rvc:', getattr(ultimate_rvc, '__version__', 'ok'))"
& $pyExe -c "import torch; print('torch:', torch.__version__, 'cuda:', torch.cuda.is_available())"

Write-Host ""
Write-Host "Pro tier installed. Start the RVC sidecar with:"
Write-Host "  $pyExe python/rvc/server.py"
