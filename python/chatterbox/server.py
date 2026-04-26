"""Chatterbox voice-cloning sidecar — HTTP service on 127.0.0.1:7010.

Runs Resemble AI's Chatterbox in its own venv (~/.lax/python-chatterbox/venv/)
because it needs torch+cu128 and there's no clean way to share the Lite
voice venv (torch+cu121 + onnxruntime-gpu).

Architecture:
  Lite voice sidecar    (:7008): Whisper STT + Silero VAD + Kokoro TTS
  Pro RVC sidecar       (:7009): ultimate-rvc (legacy, may be dropped)
  Studio Chatterbox     (:7010): Resemble AI Chatterbox (high-quality cloning)

Inference flow when user picks a Chatterbox voice:
  1. Lite sidecar receives `tts` cmd with voice="cb:<id>"
  2. Lite sidecar POSTs the TEXT (not Kokoro audio — Chatterbox is a single-stage
     TTS, not a converter) to /clones/<id>/synth
  3. Chatterbox synthesizes from text using the saved reference clip
  4. Returns WAV (24kHz mono float32 → re-encoded as PCM16)
  5. Lite sidecar streams it back to the browser as audio_chunks

REST endpoints:
  GET    /healthz                          → {ok, gpu, ready, sr}
  GET    /clones                           → {clones: [{id, name, duration_s}, ...]}
  POST   /clones                           → upload a reference WAV (10-30s)
  POST   /clones/{id}/synth                → audio/wav (binary), body: {text, ...opts}
  DELETE /clones/{id}                      → remove reference clip
  PATCH  /clones/{id}                      → rename (updates meta.json)

Reference clips live at ~/.lax/voices-chatterbox/<id>/ref.wav + meta.json.
"""

import io
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np  # noqa: F401  (used by callers)

logging.basicConfig(
    level=os.environ.get("LAX_CHATTERBOX_LOG", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("lax-chatterbox")

VOICES_DIR = os.path.expanduser("~/.lax/voices-chatterbox")
os.makedirs(VOICES_DIR, exist_ok=True)


def _detect_gpu() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:
        pass
    return ""


# Lazy load — first import of chatterbox pulls a lot. Defer to first use
# unless preload is forced.
_model = None


def _load_model():
    """Returns the loaded ChatterboxTTS model. First call ~5-15s for weight
    download + VRAM allocation; subsequent calls are instant."""
    global _model
    if _model is not None:
        return _model
    log.info("loading chatterbox-tts (first request - ~10-15s for model download/load)...")
    t0 = time.time()
    # PyTorch 2.6 changed torch.load default weights_only=True; chatterbox's
    # checkpoints are legacy .tar format requiring weights_only=False. Patch
    # the global default before chatterbox imports run their loads. Safe
    # here because we trust the ResembleAI/chatterbox HF repo.
    import torch
    _orig_torch_load = torch.load
    def _patched_load(*args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return _orig_torch_load(*args, **kwargs)
    torch.load = _patched_load  # type: ignore[assignment]
    try:
        # Prefer Chatterbox Turbo (1-step distilled decoder, ~3-5x faster
        # than standard ChatterboxTTS at similar quality). Falls back to
        # standard if the installed package only ships ChatterboxTTS.
        ChatterboxClass = None
        try:
            from chatterbox.tts_turbo import ChatterboxTurboTTS as ChatterboxClass  # type: ignore[no-redef]
            log.info("  using ChatterboxTurboTTS (1-step distilled, fast path)")
        except ImportError:
            try:
                from chatterbox.tts import ChatterboxTTS as ChatterboxClass  # type: ignore[no-redef]
                log.info("  using standard ChatterboxTTS (Turbo not installed)")
            except ImportError:
                from chatterbox import ChatterboxTTS as ChatterboxClass  # type: ignore[no-redef]
        device = "cuda" if _detect_gpu() else "cpu"
        _model = ChatterboxClass.from_pretrained(device=device)
    finally:
        torch.load = _orig_torch_load  # type: ignore[assignment]
    log.info(f"  chatterbox-tts ready in {time.time() - t0:.1f}s on {device}, sr={_model.sr}")
    return _model


@asynccontextmanager
async def lifespan(app):
    log.info("lax-chatterbox sidecar starting")
    gpu = _detect_gpu()
    if gpu:
        log.info(f"cuda available: {gpu}")
    else:
        log.warning("no CUDA — Chatterbox will fall back to CPU (very slow)")
    if os.environ.get("LAX_CHATTERBOX_PRELOAD", "1") == "1":
        try:
            _load_model()
        except Exception as e:
            log.exception(f"pre-warm failed (will retry on first request): {e}")
        # Pre-warm synth: the very first generate() call after model load
        # pays a ~20s cold-start tax (CUDA kernel JIT + model graph init).
        # Burn that cost at boot using any registered clone, so the user's
        # first real request hits the ~1s warm path instead of the wall.
        if _model is not None and os.environ.get("LAX_CHATTERBOX_PREWARM_SYNTH", "1") == "1":
            try:
                clones = _list_clones()
                if clones:
                    ref = _ref_path(clones[0]["id"])
                    log.info(f"  pre-warm synth using {clones[0]['id']!r} (one-time ~20s cold-start)...")
                    t0 = time.time()
                    _model.generate("Warming up the model.", audio_prompt_path=str(ref))
                    log.info(f"  pre-warm synth done in {time.time() - t0:.1f}s — first user request will hit warm path")
                else:
                    log.info("  no registered clones yet, skipping pre-warm synth (first user request will pay ~20s cold-start)")
            except Exception as e:
                log.warning(f"pre-warm synth failed (non-fatal): {e}")
    yield
    log.info("lax-chatterbox sidecar shutdown")


from fastapi import FastAPI, HTTPException, Body  # noqa: E402
from fastapi.responses import Response  # noqa: E402

app = FastAPI(lifespan=lifespan)


# ── Reference-clip storage ────────────────────────────────────────────────

def _voice_dir(voice_id: str) -> Path:
    return Path(VOICES_DIR) / voice_id


def _ref_path(voice_id: str) -> Path:
    return _voice_dir(voice_id) / "ref.wav"


def _meta_path(voice_id: str) -> Path:
    return _voice_dir(voice_id) / "meta.json"


def _list_clones() -> list:
    out = []
    if not os.path.isdir(VOICES_DIR):
        return out
    for entry in sorted(os.listdir(VOICES_DIR)):
        meta = _meta_path(entry)
        ref = _ref_path(entry)
        if not meta.is_file() or not ref.is_file():
            continue
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
            out.append({
                "id": entry,
                "name": data.get("name", entry),
                "duration_s": data.get("duration_s", 0),
                "created_at": data.get("created_at", 0),
            })
        except Exception as e:
            log.warning(f"could not read clone {entry}: {e}")
    return out


# ── Endpoints ─────────────────────────────────────────────────────────────

@app.get("/healthz")
async def healthz():
    sr = _model.sr if _model is not None else 0
    return {
        "ok": True,
        "gpu": _detect_gpu() or "cpu-only",
        "tier": "studio",
        "ready": _model is not None,
        "sr": sr,
        "voices_dir": VOICES_DIR,
    }


@app.get("/clones")
async def list_clones():
    return {"clones": _list_clones()}


@app.post("/clones")
async def upload_clone(payload: dict = Body(...)):
    """Save a reference audio clip (10-30s of clean speech). Body:
    {name, audio_b64, id?}. Returns {id, name, duration_s}."""
    import base64
    import soundfile as sf

    name = (payload.get("name") or "").strip() or "Untitled Voice"
    audio_b64 = payload.get("audio_b64") or ""
    if not audio_b64:
        raise HTTPException(400, "audio_b64 required")
    voice_id = payload.get("id") or uuid.uuid4().hex[:12]

    try:
        wav_bytes = base64.b64decode(audio_b64)
    except Exception as e:
        raise HTTPException(400, f"audio_b64 not valid base64: {e}")

    # Decode + duration sanity check
    try:
        samples, sr = sf.read(io.BytesIO(wav_bytes))
    except Exception as e:
        raise HTTPException(400, f"could not decode audio: {e}")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)  # mono
    duration = len(samples) / sr
    if duration < 3:
        raise HTTPException(400, f"reference too short ({duration:.1f}s); 10-30s recommended")
    if duration > 60:
        raise HTTPException(400, f"reference too long ({duration:.1f}s); trim to 10-30s for best results")

    d = _voice_dir(voice_id)
    d.mkdir(parents=True, exist_ok=True)
    sf.write(_ref_path(voice_id), samples, int(sr), subtype="PCM_16")
    meta = {
        "name": name,
        "created_at": int(time.time()),
        "duration_s": round(duration, 2),
    }
    _meta_path(voice_id).write_text(json.dumps(meta), encoding="utf-8")
    log.info(f"registered chatterbox clone {voice_id} '{name}' ({duration:.1f}s)")
    return {"id": voice_id, **meta}


@app.post("/clones/{voice_id}/synth")
async def synth_with_clone(voice_id: str, payload: dict = Body(...)):
    """Synthesize text using the saved reference clip. Body: {text, exaggeration?, cfg_weight?}.
    Returns audio/wav (binary, 24kHz mono PCM16)."""
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text required")
    ref = _ref_path(voice_id)
    if not ref.is_file():
        raise HTTPException(404, f"clone {voice_id!r} not found")

    model = _load_model()
    exaggeration = float(payload.get("exaggeration", 0.5))
    cfg_weight = float(payload.get("cfg_weight", 0.5))

    t0 = time.time()
    try:
        wav = model.generate(
            text,
            audio_prompt_path=str(ref),
            exaggeration=exaggeration,
            cfg_weight=cfg_weight,
        )
    except Exception as e:
        log.exception(f"synth failed for voice={voice_id}")
        raise HTTPException(500, f"synth: {e}")
    synth_ms = int((time.time() - t0) * 1000)

    # Convert tensor -> WAV bytes
    import soundfile as sf
    if hasattr(wav, "cpu"):
        wav = wav.cpu().numpy()
    if wav.ndim > 1:
        wav = wav.squeeze()
    buf = io.BytesIO()
    sf.write(buf, wav.astype("float32"), int(model.sr), subtype="PCM_16", format="WAV")
    log.info(f"synth voice={voice_id} text_len={len(text)} samples={len(wav)}@{model.sr}Hz {synth_ms}ms")
    return Response(content=buf.getvalue(), media_type="audio/wav", headers={"X-Synth-Ms": str(synth_ms)})


@app.delete("/clones/{voice_id}")
async def delete_clone(voice_id: str):
    import shutil
    d = _voice_dir(voice_id)
    if not d.is_dir():
        raise HTTPException(404, "not found")
    shutil.rmtree(d, ignore_errors=True)
    return {"ok": True, "deleted": voice_id}


@app.patch("/clones/{voice_id}")
async def rename_clone(voice_id: str, payload: dict = Body(...)):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    meta = _meta_path(voice_id)
    if not meta.is_file():
        raise HTTPException(404, "not found")
    data = json.loads(meta.read_text(encoding="utf-8"))
    data["name"] = name
    meta.write_text(json.dumps(data), encoding="utf-8")
    log.info(f"renamed chatterbox clone {voice_id} -> '{name}'")
    return {"id": voice_id, "name": name}


def main():
    import uvicorn
    port = int(os.environ.get("LAX_CHATTERBOX_PORT", "7010"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
