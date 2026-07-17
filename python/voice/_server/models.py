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

# STT device state. Starts on cuda; drops to cpu for the rest of the process
# when a GPU-crash signature fires mid-transcribe (e.g. cuBLAS built without
# kernels for this GPU generation). The fallback reason is queued once so the
# session layer can surface it to the user — degraded STT must be VISIBLE,
# a silently slower mic is how "voice is broken" reports happen.
_stt_device = "cuda"
_stt_fallback_reason = None

# Substrings that identify a CUDA-stack failure (as opposed to bad audio or
# a genuine bug, which must still raise). Lowercase-matched.
_GPU_CRASH_SIGNATURES = ("cublas", "cudnn", "cuda", "out of memory")


def _is_gpu_crash(e: Exception) -> bool:
    msg = str(e).lower()
    return any(s in msg for s in _GPU_CRASH_SIGNATURES)


def pop_stt_fallback() -> str:
    """Returns the fallback reason ONCE (empty string after), so the session
    layer can emit a single stt_fallback event instead of one per utterance."""
    global _stt_fallback_reason
    reason, _stt_fallback_reason = _stt_fallback_reason, None
    return reason or ""


def _load_stt():
    global _stt
    if _stt is not None:
        return _stt
    from faster_whisper import WhisperModel
    # large-v3-turbo: distilled 4-layer decoder version of large-v3.
    # ~810MB, ~5-6x faster decode, WER within 1% of large-v3.
    size = os.environ.get("LAX_STT_MODEL", "large-v3-turbo")
    # int8_float16 is a CUDA-only compute type; the CPU fallback path forces
    # plain int8 (respecting LAX_STT_COMPUTE there could re-crash the retry).
    if _stt_device == "cuda":
        compute = os.environ.get("LAX_STT_COMPUTE", "int8_float16")
    else:
        compute = "int8"
    log.info(f"loading faster-whisper {size} {compute} on {_stt_device}...")
    t0 = time.time()
    _stt = WhisperModel(size, device=_stt_device, compute_type=compute)
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


def _neutralize_phonemizer_words_mismatch():
    """kokoro-onnx phonemizes via espeak-ng. phonemizer's words-mismatch guard
    raises RuntimeError("number of lines in input and output must be equal")
    when espeak emits a different line count than the input — a known
    espeak/phonemizer version-skew bug that fires on ordinary text. The guard
    is a sanity warning, not a correctness requirement, and the module-level
    phonemize() call kokoro uses gives no way to opt out. Left alone it makes
    tts.create() throw, which drops the whole voice turn to the edge-tts
    fallback. The raise lives in the shared _mismatched_lines(), but each mode
    class overrides process(), so pass-through every one (the pinned phonemizer
    keeps these class names stable)."""
    try:
        from phonemizer.backend.espeak import words_mismatch as wm
        passthrough = lambda self, text: text
        for cls in (wm.BaseWordsMismatch, wm.Ignore, wm.Remove, wm.Warn):
            cls.process = passthrough
    except Exception:
        pass


def _load_tts():
    global _tts
    if _tts is not None:
        return _tts
    from kokoro_onnx import Kokoro
    _neutralize_phonemizer_words_mismatch()
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


def _transcribe_once(samples: np.ndarray) -> str:
    stt = _load_stt()
    segments, _info = stt.transcribe(
        samples,
        language="en",
        beam_size=1,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    return " ".join(s.text.strip() for s in segments).strip()


def _transcribe(samples: np.ndarray) -> str:
    """Sync transcribe for use in executor. faster-whisper handles its own
    CUDA threading internally. On a CUDA-stack crash (cuBLAS/cuDNN without
    kernels for this GPU, OOM), retries THIS utterance on CPU and stays on
    CPU for the rest of the process — the mic keeps working, degraded, and
    the session layer surfaces the switch via pop_stt_fallback()."""
    global _stt, _stt_device, _stt_fallback_reason
    try:
        return _transcribe_once(samples)
    except Exception as e:
        if _stt_device != "cuda" or not _is_gpu_crash(e):
            raise
        log.warning(f"GPU transcribe failed ({e}); dropping STT to CPU for this process")
        _stt = None
        _stt_device = "cpu"
        _stt_fallback_reason = str(e)[:300]
        return _transcribe_once(samples)


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
