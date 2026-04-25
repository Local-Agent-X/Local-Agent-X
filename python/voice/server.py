"""GPU voice sidecar for Local Agent X — streaming-first.

Replaces sherpa-onnx WASM (single-threaded CPU) with CUDA pipelines:
  * faster-whisper-large-v3 int8_float16 on GPU (~80-150ms STT)
  * Silero VAD via torch.hub on GPU (~5-10ms per frame)
  * Kokoro-onnx 82M on GPU (~150-300ms TTS first-byte, then chunked stream)

Hard architectural commitments (per Primal review):
  * STREAMING WebSocket, never request/response. Audio frames flow in
    continuously; partial transcripts and audio chunks flow out.
  * VAD endpointing happens server-side here, not in Node.
  * Barge-in is a first-class WS message — cancel_tts kills the
    in-flight synthesis at the next chunk boundary, server emits
    audio_done with cancelled=true so the bridge can flush playback.
  * TTS queue is per-connection; multiple speak() calls during a single
    LLM turn pipeline naturally as the model emits sentences.

Protocol (ws://127.0.0.1:7008/voice):
  Node → server (JSON text frames):
    {"cmd":"init"}
    {"cmd":"audio","pcm":"<b64 16kHz int16>"}     # ~30ms chunk, continuous
    {"cmd":"flush"}                                # force VAD to emit final
    {"cmd":"tts","text":"...","id":<int>}         # queue a sentence
    {"cmd":"cancel_tts"}                           # drain queue + stop current
    {"cmd":"reset"}                                # clear all state, mic+tts
    {"cmd":"ping"}
  server → Node (JSON text frames):
    {"type":"ready","stt":bool,"tts":bool,"gpu":"..."}
    {"type":"vad_start"}                           # speech onset
    {"type":"vad_end"}                             # speech offset
    {"type":"partial","text":"..."}                # incremental STT
    {"type":"final","text":"...","ms":<int>}       # utterance complete
    {"type":"audio_chunk","pcm":"<b64 24kHz int16>","sr":24000,"id":<int>,"final":bool}
    {"type":"audio_done","id":<int>,"ms":<int>,"cancelled":bool}
    {"type":"error","message":"..."}
    {"type":"pong"}

Health: GET /healthz → {"ok":true,"stt":bool,"tts":bool,"gpu":"..."}.
"""

import asyncio
import base64
import json
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np

# Prepend bundled CUDA DLL dirs to PATH BEFORE any CUDA-using import.
# nvidia-cublas-cu12 / nvidia-cudnn-cu12 pip wheels drop cublas64_12.dll +
# cudnn DLLs at <venv>/Lib/site-packages/nvidia/.../bin. CTranslate2
# (faster-whisper's backend) loads them via the OS DLL search path on
# Windows, so we make them findable before importing faster_whisper.
def _prepend_cuda_dlls() -> list:
    site_packages = os.path.dirname(np.__file__).rsplit(os.sep + "numpy", 1)[0]
    candidates = [
        os.path.join(site_packages, "nvidia", "cublas", "bin"),
        os.path.join(site_packages, "nvidia", "cudnn", "bin"),
    ]
    added = []
    for d in candidates:
        if os.path.isdir(d):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            if hasattr(os, "add_dll_directory"):
                try: os.add_dll_directory(d)
                except Exception: pass
            added.append(d)
    return added

_cuda_added = _prepend_cuda_dlls()

logging.basicConfig(
    level=os.environ.get("LAX_VOICE_LOG", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("lax-voice")

# Constants ───────────────────────────────────────────────────────────────
MIC_SR = 16000             # Browser mic comes in at 16kHz
TTS_SR = 24000             # Kokoro outputs at 24kHz
VAD_FRAME = 512            # Silero VAD wants 512 samples at 16kHz (32ms)
VAD_THRESH = 0.5           # Silero speech-prob threshold
SILENCE_FRAMES_END = 12    # ~384ms silence → end of speech
SPEECH_FRAMES_START = 3    # ~96ms speech → start of speech
PARTIAL_INTERVAL_S = 0.5   # Run partial STT every 500ms during active speech
MIN_UTTERANCE_S = 0.25     # Skip Whisper on shorter
TTS_CHUNK_MS = 80          # WebSocket out-chunk size for TTS

# Module-level model holders — load once, share across all WS connections
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
    # The right choice for live voice. Override with LAX_STT_MODEL.
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
    # Silero is tiny (~600KB), so even on CPU it's <5ms per 32ms frame.
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
    # Kokoro's constructor doesn't accept a providers list; it builds an
    # InferenceSession internally with onnxruntime's default provider order.
    # With onnxruntime-gpu installed, that ordering is
    # [CUDAExecutionProvider, CPUExecutionProvider] — so CUDA gets used
    # automatically when the cuDNN/CUDA runtime is available.
    _tts = Kokoro(model_path=model_path, voices_path=voices_path)
    log.info(f"  kokoro-onnx ready in {time.time() - t0:.2f}s")
    return _tts


# Per-connection state ────────────────────────────────────────────────────
class Session:
    """One per WS connection. Holds the audio buffer, VAD state, and the
    TTS pipeline queue. STT/VAD/TTS models are shared at module level."""

    def __init__(self, ws):
        self.ws = ws
        # Audio accumulator (16kHz mono float32)
        self.audio = np.zeros(0, dtype=np.float32)
        # VAD state machine
        self.in_speech = False
        self.consecutive_speech = 0
        self.consecutive_silence = 0
        self.utterance_start_idx = 0
        self.last_partial_t = 0.0
        # TTS queue + cancel
        self.tts_queue: asyncio.Queue = asyncio.Queue()
        self.tts_cancel = False
        self.tts_task: Optional[asyncio.Task] = None

    async def start_tts_worker(self):
        if self.tts_task is None or self.tts_task.done():
            self.tts_task = asyncio.create_task(self._tts_worker())

    async def stop_tts_worker(self):
        if self.tts_task and not self.tts_task.done():
            self.tts_task.cancel()
            try:
                await self.tts_task
            except asyncio.CancelledError:
                pass

    async def _tts_worker(self):
        while True:
            job = await self.tts_queue.get()
            if job is None:
                continue
            text, sentence_id, voice, speed = job
            if self.tts_cancel:
                # Drain remaining queue items and emit audio_done cancelled
                await self._send({"type": "audio_done", "id": sentence_id, "ms": 0, "cancelled": True})
                continue
            await self._synthesize_one(text, sentence_id, voice, speed)

    async def _synthesize_one(self, text: str, sentence_id: int, voice: str, speed: float):
        loop = asyncio.get_running_loop()
        t0 = time.time()
        # Voice catalog (Kokoro v1.0): af_* American female (alloy, aoede,
        # bella, jessica, kore, nicole, nova, river, sarah, sky, heart),
        # am_* American male (adam, echo, eric, fenrir, liam, michael, onyx,
        # puck, santa), bf_* / bm_* British female / male.
        # Per-call overrides come from the tts msg (set by the browser's
        # voice settings panel); fallback is LAX_TTS_VOICE / LAX_TTS_SPEED.
        try:
            tts = _load_tts()
            samples, sample_rate = await loop.run_in_executor(
                None,
                lambda: tts.create(text, voice=voice, speed=speed, lang="en-us"),
            )
        except Exception as e:
            log.exception(f"tts synth failed for id={sentence_id}")
            await self._send({"type": "error", "message": f"tts: {e}"})
            await self._send({"type": "audio_done", "id": sentence_id, "ms": int((time.time() - t0) * 1000), "cancelled": False})
            return

        if self.tts_cancel:
            await self._send({"type": "audio_done", "id": sentence_id, "ms": int((time.time() - t0) * 1000), "cancelled": True})
            return

        # Chunk to ~80ms so playback can start mid-sentence on the browser
        chunk_n = int(sample_rate * (TTS_CHUNK_MS / 1000.0))
        for i in range(0, len(samples), chunk_n):
            if self.tts_cancel:
                break
            chunk = samples[i:i + chunk_n]
            await self._send({
                "type": "audio_chunk",
                "pcm": _f32_to_b64_int16(chunk),
                "sr": int(sample_rate),
                "id": sentence_id,
                "final": (i + chunk_n) >= len(samples),
            })
            # Yield back to event loop between chunks so cancel can land
            await asyncio.sleep(0)
        await self._send({
            "type": "audio_done",
            "id": sentence_id,
            "ms": int((time.time() - t0) * 1000),
            "cancelled": self.tts_cancel,
        })

    async def cancel_tts(self):
        self.tts_cancel = True
        # Drain queue
        while not self.tts_queue.empty():
            try:
                self.tts_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        # Reset cancel flag for the next batch
        await asyncio.sleep(0)
        self.tts_cancel = False

    async def queue_tts(self, text: str, sentence_id: int, voice: str, speed: float):
        await self.tts_queue.put((text, sentence_id, voice, speed))
        await self.start_tts_worker()

    async def feed_audio(self, pcm_int16: np.ndarray):
        """Append a mic chunk and run VAD on every full 512-sample window."""
        floats = pcm_int16.astype(np.float32) / 32768.0
        self.audio = np.concatenate([self.audio, floats])
        # Walk the new region in 512-sample frames
        frame_count = (len(self.audio) - self._vad_consumed_until()) // VAD_FRAME
        if frame_count <= 0:
            return
        for _ in range(frame_count):
            base = self._vad_consumed_until()
            frame = self.audio[base:base + VAD_FRAME]
            await self._vad_step(frame)

        # Periodic partial transcription during active speech
        now = time.time()
        if self.in_speech and (now - self.last_partial_t) >= PARTIAL_INTERVAL_S:
            self.last_partial_t = now
            await self._emit_partial()

    def _vad_consumed_until(self) -> int:
        """Index in self.audio up to which we've fed VAD."""
        return getattr(self, "_vad_consumed_n", 0)

    def _set_vad_consumed(self, n: int):
        self._vad_consumed_n = n

    async def _vad_step(self, frame: np.ndarray):
        # silero-vad's input validator wants a torch tensor even when the
        # underlying inference path is ONNX. Forward to onnxruntime
        # internally; we just convert numpy -> torch on the boundary.
        # Returns a torch tensor of shape (1, 1) with the speech prob.
        import torch
        vad = _load_vad()
        t = torch.from_numpy(frame)
        prob = float(vad(t, MIC_SR).item())

        speech = prob >= VAD_THRESH
        if speech:
            self.consecutive_speech += 1
            self.consecutive_silence = 0
        else:
            self.consecutive_silence += 1
            self.consecutive_speech = 0

        if not self.in_speech and self.consecutive_speech >= SPEECH_FRAMES_START:
            self.in_speech = True
            # Mark utterance start ~300ms before VAD fired (pre-roll for the
            # word's onset that VAD needed time to confirm)
            preroll = int(MIC_SR * 0.3)
            self.utterance_start_idx = max(0, self._vad_consumed_until() - preroll)
            await self._send({"type": "vad_start"})
            self.last_partial_t = time.time()

        elif self.in_speech and self.consecutive_silence >= SILENCE_FRAMES_END:
            self.in_speech = False
            await self._send({"type": "vad_end"})
            await self._emit_final()

        self._set_vad_consumed(self._vad_consumed_until() + VAD_FRAME)

    async def _emit_partial(self):
        if not self.in_speech:
            return
        end_idx = self._vad_consumed_until()
        clip = self.audio[self.utterance_start_idx:end_idx]
        if len(clip) < int(MIN_UTTERANCE_S * MIC_SR):
            return
        loop = asyncio.get_running_loop()
        try:
            text = await loop.run_in_executor(None, lambda: _transcribe(clip))
        except Exception as e:
            log.warning(f"partial stt failed: {e}")
            return
        if text:
            await self._send({"type": "partial", "text": text})

    async def _emit_final(self):
        end_idx = self._vad_consumed_until()
        clip = self.audio[self.utterance_start_idx:end_idx]
        if len(clip) < int(MIN_UTTERANCE_S * MIC_SR):
            return
        loop = asyncio.get_running_loop()
        t0 = time.time()
        try:
            text = await loop.run_in_executor(None, lambda: _transcribe(clip))
        except Exception as e:
            await self._send({"type": "error", "message": f"final stt: {e}"})
            return
        ms = int((time.time() - t0) * 1000)
        # Compact the audio buffer — we don't need previous utterance audio
        self.audio = self.audio[end_idx:]
        self._set_vad_consumed(0)
        self.utterance_start_idx = 0
        await self._send({"type": "final", "text": text, "ms": ms})

    async def reset(self):
        self.audio = np.zeros(0, dtype=np.float32)
        self.in_speech = False
        self.consecutive_speech = 0
        self.consecutive_silence = 0
        self.utterance_start_idx = 0
        self._set_vad_consumed(0)
        await self.cancel_tts()

    async def _send(self, msg: dict):
        try:
            await self.ws.send_text(json.dumps(msg))
        except Exception:
            pass


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


def _b64_to_int16(b64: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype=np.int16)


def _f32_to_b64_int16(samples: np.ndarray) -> str:
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    return base64.b64encode(pcm.tobytes()).decode("ascii")


# FastAPI ─────────────────────────────────────────────────────────────────
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
    # Get the actual GPU name via nvidia-smi if available
    try:
        import subprocess
        r = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                           capture_output=True, text=True, timeout=2)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip().splitlines()[0].strip()
    except Exception:
        pass
    return "CUDA"


@asynccontextmanager
async def lifespan(app):
    log.info(f"lax-voice sidecar starting on python {sys.version.split()[0]}")
    if _cuda_added:
        for d in _cuda_added:
            log.info(f"  cuda dll dir on PATH: {d}")
    else:
        log.warning("nvidia-cublas-cu12 / nvidia-cudnn-cu12 wheels not found in venv - faster-whisper GPU will fail at runtime")
    gpu = _detect_gpu()
    if gpu:
        log.info(f"onnxruntime cuda available: {gpu}")
    else:
        log.warning("onnxruntime CUDAExecutionProvider not available - voice will be slow on cpu")
    # Pre-warm models so the first voice session doesn't pay model-load
    # latency (Whisper-turbo first download is ~810MB; subsequent loads
    # are ~2sec from disk; avoid forcing the user to sit on a dead browser
    # tab while it happens). Skip if env says so for fast dev iteration.
    if os.environ.get("LAX_VOICE_PRELOAD", "1") == "1":
        log.info("pre-warming models...")
        try:
            _load_stt()
            _load_vad()
            _load_tts()
            log.info("all models pre-warmed")
        except Exception as e:
            log.exception(f"pre-warm failed (continuing, will retry on first request): {e}")
    yield
    log.info("lax-voice sidecar shutdown")


from fastapi import FastAPI, WebSocket, WebSocketDisconnect  # noqa: E402

app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    return {"ok": True, "stt": _stt is not None, "tts": _tts is not None, "gpu": _detect_gpu() or "cpu-only"}


@app.websocket("/voice")
async def voice_ws(ws: WebSocket):
    await ws.accept()
    sess = Session(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError as e:
                await sess._send({"type": "error", "message": f"bad json: {e}"})
                continue

            cmd = msg.get("cmd")
            if cmd == "ping":
                await sess._send({"type": "pong"})

            elif cmd == "init":
                try:
                    _load_stt()
                    _load_vad()
                    _load_tts()
                    await sess._send({
                        "type": "ready",
                        "stt": _stt is not None,
                        "tts": _tts is not None,
                        "gpu": _detect_gpu() or "cpu-only",
                    })
                except Exception as e:
                    log.exception("init failed")
                    await sess._send({"type": "error", "message": f"init: {e}"})

            elif cmd == "audio":
                try:
                    pcm = _b64_to_int16(msg["pcm"])
                    await sess.feed_audio(pcm)
                except Exception as e:
                    log.warning(f"audio frame failed: {e}")

            elif cmd == "flush":
                if sess.in_speech:
                    sess.in_speech = False
                    await sess._send({"type": "vad_end"})
                    await sess._emit_final()

            elif cmd == "tts":
                text = (msg.get("text") or "").strip()
                sentence_id = int(msg.get("id", 0))
                # Per-message voice/speed override; fall back to env defaults.
                voice = msg.get("voice") or os.environ.get("LAX_TTS_VOICE", "am_michael")
                speed_raw = msg.get("speed")
                try:
                    speed = float(speed_raw) if speed_raw is not None else float(os.environ.get("LAX_TTS_SPEED", "1.15"))
                except (TypeError, ValueError):
                    speed = float(os.environ.get("LAX_TTS_SPEED", "1.15"))
                if text:
                    await sess.queue_tts(text, sentence_id, voice, speed)

            elif cmd == "cancel_tts":
                await sess.cancel_tts()

            elif cmd == "reset":
                await sess.reset()

            else:
                await sess._send({"type": "error", "message": f"unknown cmd: {cmd}"})

    except WebSocketDisconnect:
        log.info("client disconnected")
    except Exception as e:
        log.exception("ws fatal")
    finally:
        await sess.stop_tts_worker()


def main():
    import uvicorn
    port = int(os.environ.get("LAX_VOICE_PORT", "7008"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
