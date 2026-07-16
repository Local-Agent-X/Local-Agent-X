"""Verify pass for the Lite voice venv - run by install.ps1 / install.sh.

This is the "did the install ACTUALLY work" gate, not a nice-to-have report.
pip's exit code is necessary but not sufficient: a resolution can fail after
the venv exists (leaving a venv with nothing but pip in it), and on Windows
Defender can delete a wheel mid-extract while pip still reports success. Only
an actual import proves the venv can run the sidecar, so this exits non-zero
if any critical module is missing and the installer propagates that failure.
Mirrors the $VerifyImports pass in python/sovits/install.ps1.

Exit codes:
  0 - every critical module imported (CUDA may or may not be present)
  1 - at least one critical module failed to import; venv is not usable
"""

import importlib
import sys

# Modules server.py walks into on import. Keep aligned with requirements.txt -
# a short "just torch + fastapi" list lies, because pip can roll back an entire
# `-r requirements.txt` batch and leave the venv missing everything else while
# those few still import. numpy is first because its absence is what crashed
# the sidecar at boot (_server/cuda_bootstrap.py imports it at module scope).
CRITICAL = [
    "numpy",
    "faster_whisper",
    "kokoro_onnx",
    "phonemizer",  # provided by the phonemizer-fork distribution
    "onnxruntime",
    "silero_vad",
    "soundfile",
    "fastapi",
    "uvicorn",
    "websockets",
    "torch",
    "torchaudio",
]

print("python", sys.version.split()[0])

failed = []
for name in CRITICAL:
    try:
        mod = importlib.import_module(name)
        print("  ok  ", name, getattr(mod, "__version__", "?"))
    except Exception as e:  # noqa: BLE001 - any import failure is a failed install
        failed.append((name, "%s: %s" % (type(e).__name__, e)))
        print("  FAIL", name, "-", "%s: %s" % (type(e).__name__, e))

if failed:
    # Everything goes to stdout, never stderr: install.ps1 runs this under
    # $ErrorActionPreference='Stop' and captures with `2>&1`, and Windows
    # PowerShell 5.1 wraps a native command's stderr lines in ErrorRecords
    # that then terminate the script - so a stderr write here would replace
    # the clean diagnosis below with a PowerShell traceback. The exit code is
    # the signal; this text is just for the human.
    print("")
    print("ERROR: %d critical module(s) failed to import:" % len(failed))
    for name, err in failed:
        print("  - %s: %s" % (name, err))
    print("")
    print("The venv is NOT usable. Common causes:")
    print("  - pip install failed earlier (scroll up for the resolution error)")
    print("  - antivirus deleted a wheel mid-install (add ~/.lax to exclusions, retry)")
    sys.exit(1)

# GPU report. None of this is fatal - every path has a CPU fallback. Report
# each engine SEPARATELY rather than reading torch.cuda as the verdict for the
# whole sidecar: torch here is the PyPI wheel (CPU-only on Windows) and drives
# only silero-vad, while STT (CTranslate2) and TTS (onnxruntime-gpu) reach the
# GPU by their own routes. "torch.cuda is False" therefore does NOT mean the
# sidecar runs on CPU, and saying so would send someone debugging the wrong
# layer.
try:
    import torch

    if torch.cuda.is_available():
        print("torch cuda: True", torch.cuda.get_device_name(0), "(silero-vad)")
    else:
        print("torch cuda: False - silero-vad on CPU (cheap; the PyPI torch wheel is CPU-only on Windows)")
except Exception as e:  # noqa: BLE001
    print("torch cuda: unknown (%s: %s)" % (type(e).__name__, e))

try:
    import onnxruntime as ort

    providers = ort.get_available_providers()
    gpu = [p for p in providers if p != "CPUExecutionProvider"]
    print("onnxruntime providers:", ", ".join(providers))
    print("kokoro TTS:", "GPU-capable" if gpu else "CPU only")
except Exception:  # noqa: BLE001 - already proven importable above
    pass

print("")
print("verify OK - all critical modules import")
sys.exit(0)
