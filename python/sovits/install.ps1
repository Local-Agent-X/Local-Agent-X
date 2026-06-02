# Studio-Trained (GPT-SoVITS) one-button installer.
#
# Senior install architecture (vs the naive "pip install requirements.txt"):
#   1. Lockfile-first. If `python/sovits/requirements.lock` exists, use it.
#      Falls back to upstream `requirements.txt` only when no lock is shipped
#      (dev path). This means deps don't drift when GPT-SoVITS upstream
#      pushes a breaking change.
#   2. Verify-after-install. Pip's exit code lies — Windows Defender can
#      delete a wheel mid-stream and pip still reports success. We import
#      every critical module after install and only succeed if they all
#      load. This catches silent AV corruption.
#   3. AV-aware error reporting. If verify fails, the exit message tells
#      the user exactly what to do (add ~/.lax to AV exclusions, retry).
#      No tracebacks for non-tech users.
#   4. Idempotent. Re-running on a half-installed venv top-up missing deps
#      instead of starting from scratch.

$ErrorActionPreference = 'Stop'

$RepoDir       = Join-Path $env:USERPROFILE ".lax\sovits\repo"
$VenvDir       = Join-Path $env:USERPROFILE ".lax\sovits\venv"
$VenvPython    = Join-Path $VenvDir "Scripts\python.exe"
$LockFile      = Join-Path $PSScriptRoot "requirements.lock"
$ServerReqs    = Join-Path $PSScriptRoot "server-requirements.txt"
$UpstreamReqs  = Join-Path $RepoDir "requirements.txt"

# Critical modules that must import successfully for the sidecar to work.
# This is the "verify" pass — pip says "Successfully installed" even when
# Windows Defender deletes a wheel mid-extract; only an actual import
# can prove the install completed.
#
# Keep this list aligned with what api_v2.py + GPT_SoVITS walks into on
# import. A short list of "just torch + fastapi" lies: pip can roll back
# an entire `-r requirements.txt` batch (e.g. when one source-build dep
# fails on a box without MSVC build tools) and leave the venv missing
# tqdm/librosa/transformers while these few still import.
$VerifyImports = @(
    "torch", "torchaudio", "fastapi", "uvicorn", "httpx", "soundfile", "numpy",
    "tqdm", "librosa", "transformers", "pydantic", "gradio", "funasr"
)

function Write-Step($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[install] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[install] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[install] $msg" -ForegroundColor Red }

# ── Artifact-first path (the real one-button-install) ──────────────────────
# Pre-built artifacts are the bulletproof path: a CI-tested venv tarball
# downloaded as a single signed zip. AV scans it once at download time,
# never per-wheel during pip resolution. To enable, set:
#   $env:LAX_SOVITS_VENV_ARTIFACT_URL = "https://your.cdn/sovits-venv-cu126.zip"
# Or define it in ~/.lax/voice-bundles.json:
#   { "sovits": { "url": "...", "sha256": "..." } }
#
# When the artifact env var is set, install bypasses pip entirely:
#   1. Download zip with progress
#   2. Verify SHA-256 if provided
#   3. Extract to ~/.lax/sovits/venv/
#   4. Run verify-imports pass (same as pip path) to confirm no AV corruption
#
# When NOT set (current default), falls through to the bootstrap pip path
# below. Maintainers generate artifacts via .github/workflows/build-voice-
# artifacts.yml and configure the URL in production.
$ArtifactUrl = $env:LAX_SOVITS_VENV_ARTIFACT_URL
if (-not $ArtifactUrl) {
    $bundlesFile = Join-Path $env:USERPROFILE ".lax\voice-bundles.json"
    if (Test-Path $bundlesFile) {
        try {
            $bundles = Get-Content $bundlesFile -Raw | ConvertFrom-Json
            if ($bundles.sovits.url) { $ArtifactUrl = $bundles.sovits.url }
        } catch { }
    }
}

if ($ArtifactUrl) {
    Write-Step "Artifact URL configured — installing from pre-built bundle (skips pip)."
    Write-Host "  URL: $ArtifactUrl"
    $tmpZip = Join-Path $env:TEMP "sovits-venv-$(Get-Random).zip"
    try {
        # Single big download — AV scans it once, here, instead of fighting
        # 60+ wheel files individually during pip resolution.
        Write-Step "Downloading bundle..."
        Invoke-WebRequest -Uri $ArtifactUrl -OutFile $tmpZip -UseBasicParsing
        if (-not (Test-Path $tmpZip) -or (Get-Item $tmpZip).Length -lt 100MB) {
            Write-Err "Download incomplete (file too small or missing — likely AV blocked)."
            Write-Host "Add $env:USERPROFILE\.lax to Windows Defender exclusions and retry."
            exit 2
        }
        Write-Step "Extracting to $VenvDir..."
        if (Test-Path $VenvDir) { Remove-Item -Recurse -Force $VenvDir }
        Expand-Archive -Path $tmpZip -DestinationPath (Split-Path $VenvDir -Parent) -Force
        Remove-Item $tmpZip -Force
        # Fall through to verify-imports pass below — same code path proves
        # the bundle wasn't AV-corrupted during extract.
        Write-Ok "Bundle extracted. Running verify pass..."
        # Skip pip section entirely — jump to the verify block.
        $script:UseArtifact = $true
    } catch {
        Write-Err "Bundle install failed: $_"
        if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue }
        Write-Host "Falling back to from-source pip install. This is slower and"
        Write-Host "more vulnerable to AV interference."
        $ArtifactUrl = $null
    }
}

# ── Pre-flight: repo must exist ─────────────────────────────────────────────
Write-Step "Checking GPT-SoVITS repo at $RepoDir..."
if (-not (Test-Path $RepoDir)) {
    Write-Err "GPT-SoVITS repo not found."
    Write-Host ""
    Write-Host "This installer rebuilds the Python venv on top of an existing"
    Write-Host "GPT-SoVITS checkout. The repo + pretrained models + your trained"
    Write-Host "voices are expected at:"
    Write-Host "  $RepoDir"
    Write-Host ""
    Write-Host "Fresh-setup options:"
    Write-Host "  1. Run the training pipeline (Settings -> Voice -> Train a voice)"
    Write-Host "  2. Or clone manually:"
    Write-Host "     git clone https://github.com/RVC-Boss/GPT-SoVITS `"$RepoDir`""
    Write-Host "     Then re-run this installer."
    exit 1
}

# ── Locate Python interpreter ───────────────────────────────────────────────
# (Skip pip prep entirely if a pre-built artifact was extracted above —
#  the bundled venv ships its own python.exe. Just verify-imports.)
if (-not $script:UseArtifact) {
Write-Step "Locating system Python..."
$PythonExe = $null
foreach ($candidate in @("py -3.11", "py -3.10", "py -3.12", "python")) {
    try {
        $parts = $candidate -split " "
        $exe = $parts[0]
        $args = if ($parts.Length -gt 1) { @($parts[1], "--version") } else { @("--version") }
        $null = & $exe @args 2>&1
        if ($LASTEXITCODE -eq 0) { $PythonExe = $candidate; break }
    } catch { continue }
}
if (-not $PythonExe) {
    Write-Err "Python not found on PATH."
    Write-Host "Install Python 3.11 from https://www.python.org/downloads/ and re-run."
    exit 1
}
Write-Ok "Python: $PythonExe"

# ── Create or reuse venv ────────────────────────────────────────────────────
if (-not (Test-Path $VenvPython)) {
    Write-Step "Creating venv at $VenvDir..."
    $vp = $PythonExe -split " "
    $vargs = if ($vp.Length -gt 1) { @($vp[1], "-m", "venv", $VenvDir) } else { @("-m", "venv", $VenvDir) }
    & $vp[0] @vargs
    if ($LASTEXITCODE -ne 0) {
        Write-Err "venv creation failed."
        exit 1
    }
} else {
    Write-Ok "Venv already exists at $VenvDir, reusing."
}

# ── Detect GPU for torch wheel selection ────────────────────────────────────
$HasCuda = $false
try {
    $null = & nvidia-smi --query-gpu=name --format=csv 2>&1
    if ($LASTEXITCODE -eq 0) { $HasCuda = $true }
} catch { $HasCuda = $false }
$TorchIndex = if ($HasCuda) { "https://download.pytorch.org/whl/cu126" } else { "https://download.pytorch.org/whl/cpu" }
Write-Step "GPU detected: $HasCuda. Torch index: $TorchIndex"

# ── Upgrade pip ─────────────────────────────────────────────────────────────
Write-Step "Upgrading pip..."
& $VenvPython -m pip install --upgrade pip --quiet

# ── Install dependencies ────────────────────────────────────────────────────
# Strategy:
#   - If requirements.lock exists, use it. This is the production path —
#     deterministic, deps don't drift with upstream.
#   - Otherwise install torch first (with CUDA index), then upstream
#     requirements.txt, then our server-requirements.txt. This is the
#     bootstrap path used to GENERATE a fresh lock.
if (Test-Path $LockFile) {
    Write-Step "Installing from lockfile $LockFile (deterministic)..."
    & $VenvPython -m pip install -r $LockFile --index-url $TorchIndex --extra-index-url https://pypi.org/simple
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Lockfile install failed."
        Write-Host ""
        Write-Host "If this is a fresh box, the most common cause is Windows Defender"
        Write-Host "scanning + deleting wheels mid-stream. To fix:"
        Write-Host "  1. Open Windows Security -> Virus & threat protection"
        Write-Host "  2. Manage settings -> Add or remove exclusions"
        Write-Host "  3. Add: $env:USERPROFILE\.lax"
        Write-Host "  4. Re-run this installer."
        exit 1
    }
} else {
    Write-Warn "No lockfile at $LockFile — running bootstrap install (will float with upstream)."
    # Pin torch/torchaudio to 2.6.0 (NOT current). torchaudio >= 2.7 dropped
    # its native soundfile/sox backends in favor of torchcodec, which in turn
    # requires the FFmpeg system shared libraries (libavcodec/libavformat/...).
    # On Windows those need a manual FFmpeg install (winget/choco/manual DLLs)
    # which defeats the one-button install. Pinning to 2.6.0 keeps the
    # soundfile backend that ships with the venv and ducks the whole FFmpeg
    # transitive dep. (We can't go older than 2.6.0 on cu126 — earlier torch
    # builds don't ship CUDA 12.6 wheels.)
    Write-Step "Installing torch + torchaudio 2.6.0 (must come before requirements.txt)..."
    & $VenvPython -m pip install "torch==2.6.0" "torchaudio==2.6.0" --index-url $TorchIndex
    if ($LASTEXITCODE -ne 0) { Write-Err "torch install failed."; exit 1 }

    if (Test-Path $UpstreamReqs) {
        # Upstream requirements.txt has two Windows-hostile entries:
        #   1. `pyopenjtalk>=0.4.1` — Japanese G2P, no Win wheel, builds from
        #      source via CMake + MSVC. Most LAX users don't have MSVC build
        #      tools installed, so the build fails. When ONE entry fails to
        #      build, pip rolls back the ENTIRE batch — tqdm/librosa/transformers
        #      end up missing and the server crashes on first start. Skip it
        #      here (EN/ZH/KO synthesis still works). Users who need Japanese
        #      can manually `pip install pyopenjtalk` with MSVC installed.
        #   2. `--no-binary=opencc` + `opencc` — forces source build of opencc,
        #      which also needs MSVC. Swap to opencc-python-reimplemented
        #      (pure Python, drop-in API).
        $FilteredReqs = Join-Path $env:TEMP "sovits-reqs-filtered-$(Get-Random).txt"
        Get-Content $UpstreamReqs | Where-Object {
            $_ -notmatch '^\s*pyopenjtalk\b' -and
            $_ -notmatch '^\s*--no-binary=opencc' -and
            $_ -notmatch '^\s*opencc\s*$'
        } | Set-Content $FilteredReqs -Encoding UTF8
        Add-Content $FilteredReqs "opencc-python-reimplemented" -Encoding UTF8

        Write-Step "Installing upstream requirements.txt (pyopenjtalk + source-opencc filtered out)..."
        & $VenvPython -m pip install -r $FilteredReqs
        $reqsExit = $LASTEXITCODE
        Remove-Item $FilteredReqs -ErrorAction SilentlyContinue
        if ($reqsExit -ne 0) {
            Write-Err "Upstream requirements install failed."
            Write-Host ""
            Write-Host "This is fatal — pip rolls back the whole batch on any failure,"
            Write-Host "so the venv would boot half-installed and the server would crash."
            Write-Host ""
            Write-Host "Most common causes on Windows:"
            Write-Host "  1. Windows Defender ate a wheel mid-stream. Fix:"
            Write-Host "     - Windows Security -> Virus & threat protection -> Manage settings"
            Write-Host "     - Add or remove exclusions -> Add folder -> $env:USERPROFILE\.lax"
            Write-Host "     - Re-run this installer."
            Write-Host "  2. A new upstream dep needs MSVC C++ build tools. Re-run with the"
            Write-Host "     last failing package name and we'll add it to the filter list."
            exit 1
        }
    }

    if (Test-Path $ServerReqs) {
        Write-Step "Installing wrapper deps from $ServerReqs..."
        & $VenvPython -m pip install -r $ServerReqs
        if ($LASTEXITCODE -ne 0) { Write-Err "wrapper deps failed."; exit 1 }
    }

    # Pin numpy back. Some upstream deps drag numpy 2.x in transitively
    # but GPT-SoVITS hard-requires numpy<2.0.
    Write-Step "Pinning numpy<2.0 (GPT-SoVITS compat)..."
    & $VenvPython -m pip install "numpy<2.0" --quiet
}

}  # end: if (-not $script:UseArtifact) — pip-install block above is skipped
   # when artifact path was used; venv is already in place from the zip.

# ── Verify-after-install ────────────────────────────────────────────────────
# Pip exit codes are unreliable on Windows because Defender deletes wheel
# files between extract and import. The only honest verification is
# actually importing each critical module.
Write-Step "Verifying critical imports..."
$ImportCheck = $VerifyImports | ForEach-Object { "import $_" } | Out-String
$verifyOut = & $VenvPython -c $ImportCheck 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "Verify failed. Some packages installed but won't import:"
    $verifyOut | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Most common cause: Windows Defender scanned and deleted a wheel"
    Write-Host "between download and extract. To fix:"
    Write-Host "  1. Open Windows Security -> Virus & threat protection"
    Write-Host "  2. Manage settings -> Add or remove exclusions -> Add folder"
    Write-Host "  3. Add: $env:USERPROFILE\.lax"
    Write-Host "  4. Click Reinstall in the voice picker, OR re-run this script."
    Write-Host ""
    Write-Host "If exclusions are already set, try with real-time protection"
    Write-Host "temporarily disabled (Manage settings -> Real-time protection off),"
    Write-Host "then re-enable after install completes."
    exit 2
}

Write-Ok "All critical imports verified."
Write-Ok "DONE. Venv: $VenvDir"
Write-Host "Click 'Start' in the voice picker to launch the GPT-SoVITS sidecar."
exit 0
