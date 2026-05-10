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
#
# Three sources of CUDA libs in this venv:
#   1. nvidia-cublas-cu12  → cublas64_12.dll (faster-whisper / CTranslate2)
#   2. nvidia-cudnn-cu12 9.1 → cudnn 9.x DLLs (onnxruntime-gpu 1.20 needs
#                              cudnnGetLibConfig which only exists in 9.x)
#   3. torch/lib/          → torch's bundled cuDNN (8.x). MUST NOT win the
#                            DLL search or onnxruntime crashes when it
#                            calls a 9.x-only symbol it doesn't find.
#
# The cuDNN order is the trap: simply prepending nvidia-cudnn's bin to
# PATH isn't enough — once torch is imported, its DLL dirs are added to
# the search path AHEAD of PATH-based dirs (Windows uses the order
# add_dll_directory was called). So we explicitly LoadLibrary the cuDNN
# 9.x DLLs into the process here, before importing anything that touches
# torch. Once a DLL is loaded, subsequent loads of the same SONAME
# return the already-loaded handle, so torch's own cuDNN can't displace
# it. Defensive but correct.
def _prepend_cuda_dlls() -> list:
    site_packages = os.path.dirname(np.__file__).rsplit(os.sep + "numpy", 1)[0]
    cublas_bin = os.path.join(site_packages, "nvidia", "cublas", "bin")
    cudnn_bin = os.path.join(site_packages, "nvidia", "cudnn", "bin")
    added = []
    # 1. Add to PATH + add_dll_directory so dynamic loads resolve here
    for d in [cudnn_bin, cublas_bin]:  # cudnn first so it wins over torch's
        if os.path.isdir(d):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            if hasattr(os, "add_dll_directory"):
                try: os.add_dll_directory(d)
                except Exception: pass
            added.append(d)
    # 2. Force-load the cuDNN 9.x DLLs into the process before torch runs.
    #    Once loaded, the handle is reused — torch's bundled cuDNN can't
    #    take over the same symbol space afterwards.
    if os.path.isdir(cudnn_bin):
        import ctypes
        for fname in os.listdir(cudnn_bin):
            if fname.lower().endswith(".dll") and "cudnn" in fname.lower():
                try:
                    ctypes.WinDLL(os.path.join(cudnn_bin, fname))
                except OSError:
                    pass  # some are dependent libs that load implicitly
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
SILENCE_FRAMES_END = 8     # ~256ms silence -> end of speech (was 384ms;
                           # tightened because faster-whisper-turbo on GPU
                           # absorbs the tighter cut without choking)
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
        # Pipelined TTS: each sentence has a Future that resolves when its
        # Kokoro / Chatterbox processing finishes. The streamer consumes
        # them in arrival order so audio chunks reach the browser in order
        # even though processing happens concurrently. This hides per-call
        # synth latency for sentences 2+ in multi-sentence replies.
        self.tts_order: asyncio.Queue = asyncio.Queue()
        self.tts_results: dict = {}      # sentence_id -> asyncio.Future[(samples, sr, prep_ms) | Exception]
        self.tts_in_flight: dict = {}    # sentence_id -> asyncio.Task (prep)
        self.tts_streamer_task: Optional[asyncio.Task] = None
        # Cap concurrent prep tasks so we don't OOM the GPU on long
        # multi-sentence replies. 3 is comfortable on a 12GB 3060.
        self.tts_prep_sem = asyncio.Semaphore(3)
        self.tts_cancel = False

    async def start_tts_worker(self):
        if self.tts_streamer_task is None or self.tts_streamer_task.done():
            self.tts_streamer_task = asyncio.create_task(self._tts_streamer())

    async def stop_tts_worker(self):
        # Cancel the streamer and any in-flight prep tasks
        for task in list(self.tts_in_flight.values()):
            task.cancel()
        self.tts_in_flight.clear()
        if self.tts_streamer_task and not self.tts_streamer_task.done():
            self.tts_streamer_task.cancel()
            try:
                await self.tts_streamer_task
            except asyncio.CancelledError:
                pass

    async def _tts_streamer(self):
        """Pulls sentence IDs in arrival order, awaits their prepared audio,
        and streams audio_chunks. Sentences are processed in parallel by
        _prep_one() but emitted in order here."""
        while True:
            sentence_id = await self.tts_order.get()
            if sentence_id is None:
                continue
            fut = self.tts_results.pop(sentence_id, None)
            if fut is None:
                continue
            if self.tts_cancel:
                await self._send({"type": "audio_done", "id": sentence_id, "ms": 0, "cancelled": True})
                continue
            try:
                samples, sample_rate, prep_ms = await fut
            except Exception as e:
                await self._send({"type": "error", "message": f"tts: {e}"})
                await self._send({"type": "audio_done", "id": sentence_id, "ms": prep_ms if isinstance(prep_ms, int) else 0, "cancelled": False})
                continue
            await self._stream_audio(samples, sample_rate, sentence_id, prep_ms)

    async def _prep_one(self, text: str, sentence_id: int, voice: str, speed: float, fut):
        """Generate audio for one sentence. Three voice routing modes:
          * voice == "sv:<id>"  → GPT-SoVITS clone (trained or zero-shot)
                                  via the SoVITS sidecar (:7012). Best quality
                                  when fine-tuned weights exist.
          * voice == "cb:<id>"  → single-stage Chatterbox (Studio tier);
                                  zero-shot fallback when no SoVITS clone exists.
          * else                → straight Kokoro built-in voice (Lite tier).
        Resolves the Future with (samples, sample_rate, prep_ms_int)."""
        async with self.tts_prep_sem:
            t0 = time.time()
            try:
                if voice.startswith("sv:"):
                    samples, sample_rate = await self._synth_via_sovits(
                        voice.split(":", 1)[1], text, sentence_id,
                    )
                elif voice.startswith("cb:"):
                    samples, sample_rate = await self._synth_via_chatterbox(
                        voice.split(":", 1)[1], text, sentence_id,
                    )
                else:
                    loop = asyncio.get_running_loop()
                    tts = _load_tts()
                    samples, sample_rate = await loop.run_in_executor(
                        None,
                        lambda: tts.create(text, voice=voice, speed=speed, lang="en-us"),
                    )
            except Exception as e:
                log.exception(f"tts synth failed for id={sentence_id}")
                if not fut.done():
                    fut.set_exception(e)
                return

            prep_ms = int((time.time() - t0) * 1000)
            if not fut.done():
                fut.set_result((samples, sample_rate, prep_ms))

    async def _synth_via_chatterbox(self, clone_id: str, text: str, sentence_id: int):
        """Studio tier: single-stage Chatterbox TTS via reference clip.
        Returns (samples_float32, sample_rate). Raises on failure so caller
        can mark the Future as errored."""
        import io
        import httpx
        import soundfile as sf

        cb_port = os.environ.get("LAX_CHATTERBOX_PORT", "7010")
        url = f"http://127.0.0.1:{cb_port}/clones/{clone_id}/synth"
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(url, json={"text": text})
        if r.status_code == 404:
            raise RuntimeError(f"chatterbox clone {clone_id!r} not installed")
        if r.status_code != 200:
            raise RuntimeError(f"chatterbox returned {r.status_code}: {r.text[:200]}")
        out_samples, out_sr = sf.read(io.BytesIO(r.content))
        if out_samples.ndim > 1:
            out_samples = out_samples.mean(axis=1)
        out_samples = out_samples.astype(np.float32)
        # Chatterbox is 24kHz native — same as Kokoro/playback worklet, no resample.
        log.info(f"  chatterbox synth id={sentence_id} clone={clone_id} -> {len(out_samples)}sa@{out_sr}Hz ({r.headers.get('X-Synth-Ms')}ms)")
        return out_samples, int(out_sr)

    async def _synth_via_sovits(self, clone_id: str, text: str, sentence_id: int):
        """GPT-SoVITS sidecar at :7012. Native output is 32 kHz mono WAV.
        Resampled to 24 kHz to match the browser playback worklet's fixed
        rate (set on voice_ready). Without this resample the audio plays
        ~33% too fast and the pitch is shifted up — Optimus sounds chipmunky.
        Returns (samples_float32, 24000). Raises on failure."""
        import io
        import httpx
        import soundfile as sf

        sv_port = os.environ.get("LAX_SOVITS_PORT", "7012")
        url = f"http://127.0.0.1:{sv_port}/clones/{clone_id}/synth"
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(url, json={"text": text})
        if r.status_code == 404:
            raise RuntimeError(f"sovits clone {clone_id!r} not installed")
        if r.status_code != 200:
            raise RuntimeError(f"sovits returned {r.status_code}: {r.text[:200]}")
        out_samples, out_sr = sf.read(io.BytesIO(r.content))
        if out_samples.ndim > 1:
            out_samples = out_samples.mean(axis=1)
        out_samples = out_samples.astype(np.float32)
        if int(out_sr) != 24000:
            try:
                from scipy.signal import resample_poly
                # gcd-based ratio: 32000 -> 24000 is up=3, down=4
                from math import gcd
                g = gcd(int(out_sr), 24000)
                up = 24000 // g
                down = int(out_sr) // g
                out_samples = resample_poly(out_samples, up, down).astype(np.float32)
            except Exception as e:
                log.warning(f"sovits resample {out_sr}->24000 failed: {e}; sending native")
                log.info(f"  sovits synth id={sentence_id} clone={clone_id} -> {len(out_samples)}sa@{out_sr}Hz (native)")
                return out_samples, int(out_sr)
        log.info(f"  sovits synth id={sentence_id} clone={clone_id} -> {len(out_samples)}sa@24000Hz (resampled from {out_sr})")
        return out_samples, 24000

    async def _stream_audio(self, samples, sample_rate: int, sentence_id: int, prep_ms: int):
        """Emit audio_chunks for already-prepared samples + the audio_done."""
        t0 = time.time()
        if self.tts_cancel:
            await self._send({"type": "audio_done", "id": sentence_id, "ms": prep_ms, "cancelled": True})
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
            await asyncio.sleep(0)
        await self._send({
            "type": "audio_done",
            "id": sentence_id,
            "ms": int((time.time() - t0) * 1000),
            "cancelled": self.tts_cancel,
        })

    async def cancel_tts(self):
        self.tts_cancel = True
        # Cancel all in-flight prep tasks
        for task in list(self.tts_in_flight.values()):
            task.cancel()
        self.tts_in_flight.clear()
        # Drain the order queue + result futures
        while not self.tts_order.empty():
            try:
                self.tts_order.get_nowait()
            except asyncio.QueueEmpty:
                break
        for fut in self.tts_results.values():
            if not fut.done():
                fut.cancel()
        self.tts_results.clear()
        # Reset cancel flag for the next batch
        await asyncio.sleep(0)
        self.tts_cancel = False

    async def queue_tts(self, text: str, sentence_id: int, voice: str, speed: float):
        # Pipelined: kick off prep immediately so it runs concurrently with
        # any prior sentence's RVC convert / playback. Streamer emits the
        # results in order via tts_order.
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self.tts_results[sentence_id] = fut
        await self.tts_order.put(sentence_id)
        prep_task = asyncio.create_task(self._prep_one(text, sentence_id, voice, speed, fut))
        self.tts_in_flight[sentence_id] = prep_task
        prep_task.add_done_callback(lambda _t, sid=sentence_id: self.tts_in_flight.pop(sid, None))
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


from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response  # noqa: E402

app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    # `ready` is the canonical "fully booted" signal voice-setup.ts checks.
    # Without it the picker shows "Installed, not running" even though the
    # sidecar is fine. Ready = both STT + TTS pre-warmed.
    stt_ready = _stt is not None
    tts_ready = _tts is not None
    return {
        "ok": True,
        "ready": stt_ready and tts_ready,
        "stt": stt_ready,
        "tts": tts_ready,
        "gpu": _detect_gpu() or "cpu-only",
    }


@app.post("/synth")
async def synth(req: Request):
    # One-shot HTTP TTS for non-WebSocket callers (Telegram/WhatsApp bridges).
    # The WS pipeline at /voice is the right path for live conversation, but
    # bridges only need text->WAV in a single round trip — wiring them through
    # WS would mean per-message handshake + chunked reassembly for nothing.
    # Returns a 24kHz mono WAV body.
    try:
        body = await req.json()
    except Exception:
        return Response(content=b'{"error":"bad json"}', status_code=400, media_type="application/json")
    text = (body.get("text") or "").strip()
    if not text:
        return Response(content=b'{"error":"text required"}', status_code=400, media_type="application/json")
    voice = body.get("voice") or os.environ.get("LAX_TTS_VOICE", "am_onyx")
    try:
        speed = float(body.get("speed") or 1.0)
    except Exception:
        speed = 1.0
    try:
        tts = _load_tts()
    except Exception as e:
        log.exception("/synth: kokoro load failed")
        return Response(content=f'{{"error":"tts load: {e}"}}'.encode(), status_code=500, media_type="application/json")
    try:
        loop = asyncio.get_running_loop()
        samples, sr = await loop.run_in_executor(
            None,
            lambda: tts.create(text, voice=voice, speed=speed, lang="en-us"),
        )
    except Exception as e:
        log.exception("/synth: kokoro synth failed")
        return Response(content=f'{{"error":"synth: {e}"}}'.encode(), status_code=500, media_type="application/json")
    # Pack to int16 mono WAV in-memory.
    import io
    import wave
    pcm16 = (np.asarray(samples) * 32767.0).clip(-32768, 32767).astype(np.int16).tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm16)
    wav = buf.getvalue()
    log.info(f"/synth voice={voice} speed={speed} chars={len(text)} -> {len(wav)}B@{sr}Hz")
    return Response(content=wav, media_type="audio/wav", headers={"X-Voice": voice, "X-Sample-Rate": str(int(sr))})


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
                log.info(f"tts cmd id={sentence_id} voice={voice} speed={speed:.2f} text={text[:40]!r}")
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
