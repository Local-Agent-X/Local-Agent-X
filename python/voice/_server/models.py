"""Lazy loaders + shared singletons for STT / VAD / TTS / GPU detection.

Module-level singletons are referenced by name from other modules
(e.g. `models._stt is not None`) so the holders must live in exactly
one place — here.
"""

import os
import time

import numpy as np

from .cuda_bootstrap import log

_stt = None
_vad_model = None
_tts = None


def _load_stt():
    global _stt
    if _stt is not None:
        return _stt
    from faster_whisper import WhisperModel
    # large-v3-turbo: distilled 4-layer decoder version of large-v3.
    # ~810MB, ~5-6x faster decode, WER within 1% of large-v3.
    size = os.environ.get("LAX_STT_MODEL", "large-v3-turbo")
    compute = os.environ.get("LAX_STT_COMPUTE", "int8_float16")
    log.info(f"loading faster-whisper {size} {compute} on cuda...")
    t0 = time.time()
    _stt = WhisperModel(size, device="cuda", compute_type=compute)
    log.info(f"  faster-whisper ready in {time.time() - t0:.2f}s")
    return _stt


def _load_vad():
    global _vad_model
    if _vad_model is not None:
        return _vad_model
    from silero_vad import load_silero_vad
    log.info("loading silero-vad (onnx, runs on the same onnxruntime-gpu as kokoro/whisper)...")
    t0 = time.time()
    # ONNX path so we don't depend on a CUDA-enabled torch install.
    _vad_model = load_silero_vad(onnx=True)
    log.info(f"  silero-vad ready in {time.time() - t0:.2f}s")
    return _vad_model


def _load_tts():
    global _tts
    if _tts is not None:
        return _tts
    from kokoro_onnx import Kokoro
    model_path = os.path.expanduser("~/.lax/python-voice/kokoro/model.onnx")
    voices_path = os.path.expanduser("~/.lax/python-voice/kokoro/voices.bin")
    log.info("loading kokoro-onnx...")
    t0 = time.time()
    # Kokoro builds its InferenceSession internally with onnxruntime's
    # default provider order. With onnxruntime-gpu installed, that is
    # [CUDAExecutionProvider, CPUExecutionProvider] — CUDA gets used
    # automatically when the cuDNN/CUDA runtime is available.
    _tts = Kokoro(model_path=model_path, voices_path=voices_path)
    log.info(f"  kokoro-onnx ready in {time.time() - t0:.2f}s")
    return _tts


def _transcribe(samples: np.ndarray) -> str:
    """Sync transcribe for use in executor. faster-whisper handles its own
    CUDA threading internally."""
    stt = _load_stt()
    segments, _info = stt.transcribe(
        samples,
        language="en",
        beam_size=1,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    return " ".join(s.text.strip() for s in segments).strip()


def _detect_gpu() -> str:
    """Return the GPU name onnxruntime can use, or empty string if CPU only.
    We don't rely on torch.cuda.is_available() because the installed torch
    is the CPU build — the actual GPU work goes through onnxruntime-gpu's
    CUDAExecutionProvider, which is independent of torch."""
    try:
        import onnxruntime as ort
        if "CUDAExecutionProvider" not in ort.get_available_providers():
            return ""
    except Exception:
        return ""
    try:
        import subprocess
        r = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                           capture_output=True, text=True, timeout=2)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip().splitlines()[0].strip()
    except Exception:
        pass
    return "CUDA"
