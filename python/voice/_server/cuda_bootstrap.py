"""CUDA DLL bootstrap — MUST be imported before torch/onnxruntime/faster-whisper.

Three sources of CUDA libs in this venv:
  1. nvidia-cublas-cu12  -> cublas64_12.dll (faster-whisper / CTranslate2)
  2. nvidia-cudnn-cu12 9.1 -> cudnn 9.x DLLs (onnxruntime-gpu 1.20 needs
                             cudnnGetLibConfig which only exists in 9.x)
  3. torch/lib/          -> torch's bundled cuDNN (8.x). MUST NOT win the
                           DLL search or onnxruntime crashes when it
                           calls a 9.x-only symbol it doesn't find.

The cuDNN order is the trap: simply prepending nvidia-cudnn's bin to
PATH isn't enough -- once torch is imported, its DLL dirs are added to
the search path AHEAD of PATH-based dirs (Windows uses the order
add_dll_directory was called). So we explicitly LoadLibrary the cuDNN
9.x DLLs into the process here, before importing anything that touches
torch. Once a DLL is loaded, subsequent loads of the same SONAME
return the already-loaded handle, so torch's own cuDNN can't displace
it. Defensive but correct.
"""

import logging
import os

import numpy as np


def _prepend_cuda_dlls() -> list:
    site_packages = os.path.dirname(np.__file__).rsplit(os.sep + "numpy", 1)[0]
    cublas_bin = os.path.join(site_packages, "nvidia", "cublas", "bin")
    cudnn_bin = os.path.join(site_packages, "nvidia", "cudnn", "bin")
    added = []
    # cudnn first so it wins over torch's bundled 8.x
    for d in [cudnn_bin, cublas_bin]:
        if os.path.isdir(d):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            if hasattr(os, "add_dll_directory"):
                try: os.add_dll_directory(d)
                except Exception: pass
            added.append(d)
    # Force-load cuDNN 9.x into the process before torch runs so torch's
    # bundled cuDNN can't take over the same symbol space afterwards.
    if os.path.isdir(cudnn_bin):
        import ctypes
        for fname in os.listdir(cudnn_bin):
            if fname.lower().endswith(".dll") and "cudnn" in fname.lower():
                try:
                    ctypes.WinDLL(os.path.join(cudnn_bin, fname))
                except OSError:
                    pass  # some are dependent libs that load implicitly
    return added


cuda_added = _prepend_cuda_dlls()

logging.basicConfig(
    level=os.environ.get("LAX_VOICE_LOG", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("lax-voice")
