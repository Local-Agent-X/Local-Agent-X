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

import os
import sys

# Allow running both as a script (`python python/voice/server.py`, used by
# the install scripts and voice-setup.ts) and as a package
# (`python -m voice.server`). In script mode there is no parent package,
# so relative imports fail; resolve by adding the package's parent dir
# to sys.path and using absolute imports below.
if __package__ in (None, ""):
    _pkg_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if _pkg_parent not in sys.path:
        sys.path.insert(0, _pkg_parent)

# CUDA DLL bootstrap MUST happen before any torch/onnxruntime/faster-whisper
# import resolves. Importing this submodule first runs _prepend_cuda_dlls()
# at module load and sets up logging.
from voice._server import cuda_bootstrap  # noqa: E402, F401, isort: skip

import asyncio  # noqa: E402
import json  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402

import numpy as np  # noqa: E402
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect  # noqa: E402

from voice._server import models  # noqa: E402
from voice._server.audio import b64_to_int16  # noqa: E402
from voice._server.cuda_bootstrap import cuda_added, log  # noqa: E402
from voice._server.models import _detect_gpu, _load_stt, _load_tts, _load_vad  # noqa: E402
from voice._server.session import Session  # noqa: E402


@asynccontextmanager
async def lifespan(app):
    log.info(f"lax-voice sidecar starting on python {sys.version.split()[0]}")
    if cuda_added:
        for d in cuda_added:
            log.info(f"  cuda dll dir on PATH: {d}")
    else:
        log.warning("nvidia-cublas-cu12 / nvidia-cudnn-cu12 wheels not found in venv - faster-whisper GPU will fail at runtime")
    gpu = _detect_gpu()
    if gpu:
        log.info(f"onnxruntime cuda available: {gpu}")
    else:
        log.warning("onnxruntime CUDAExecutionProvider not available - voice will be slow on cpu")
    # Pre-warm models so the first voice session doesn't pay model-load
    # latency. Skip via LAX_VOICE_PRELOAD=0 for fast dev iteration.
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


app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    # `ready` is the canonical "fully booted" signal voice-setup.ts checks.
    # Without it the picker shows "Installed, not running" even though the
    # sidecar is fine. Ready = both STT + TTS pre-warmed.
    stt_ready = models._stt is not None
    tts_ready = models._tts is not None
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
                        "stt": models._stt is not None,
                        "tts": models._tts is not None,
                        "gpu": _detect_gpu() or "cpu-only",
                    })
                except Exception as e:
                    log.exception("init failed")
                    await sess._send({"type": "error", "message": f"init: {e}"})

            elif cmd == "audio":
                try:
                    pcm = b64_to_int16(msg["pcm"])
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
    except Exception:
        log.exception("ws fatal")
    finally:
        await sess.stop_tts_worker()


def main():
    import uvicorn
    port = int(os.environ.get("LAX_VOICE_PORT", "7008"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
