"""RVC voice-cloning sidecar (Pro tier) — HTTP service on 127.0.0.1:7009.

Runs ultimate-rvc in its own venv (~/.lax/python-rvc/venv/) so the heavy
torch+cu128 stack doesn't conflict with the Lite voice sidecar's
torch+cu121 + onnxruntime-gpu stack.

Architecture:
  Lite voice sidecar (:7008): Whisper STT + Silero VAD + Kokoro TTS
  Pro RVC sidecar    (:7009): ultimate-rvc voice conversion + training

Inference flow when user picks a cloned voice:
  1. Lite sidecar synthesizes the sentence with Kokoro (~150ms)
  2. Lite sidecar POSTs the WAV to /infer with the target voice_id
  3. RVC sidecar runs voice conversion (~0.3-0.5x real-time on RTX 3060)
  4. RVC returns the converted WAV
  5. Lite sidecar streams it back to the browser as audio_chunks

Training flow when user uploads a sample:
  1. POST /clones with name + audio_b64 → returns voice_id (untrained)
  2. POST /clones/{voice_id}/train kicks off training (returns job_id)
  3. GET /clones/{voice_id}/train/{job_id} polled for progress
  4. When complete, .pth and .index land in ~/.lax/voices/<voice_id>/

REST endpoints:
  GET    /healthz                            → {ok, gpu, models_loaded}
  GET    /clones                             → [{id, name, status, ...}]
  POST   /clones                             → {id} (register, no training)
  POST   /clones/{id}/train                  → {job_id}
  GET    /clones/{id}/train/{job_id}         → {progress, status, log}
  POST   /clones/{id}/infer                  → audio/wav (binary)
  DELETE /clones/{id}                        → {ok}
  PATCH  /clones/{id}                        → {ok} (rename)
"""

# NOTE: This is the scaffolding — actual ultimate-rvc integration lands
# once Python 3.12 + ultimate-rvc are installed. The endpoints below
# return 501 Not Implemented until then.

import json
import logging
import os
import time
from contextlib import asynccontextmanager

import numpy as np  # noqa: F401  (will be used by inference path)

logging.basicConfig(
    level=os.environ.get("LAX_RVC_LOG", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("lax-rvc")

VOICES_DIR = os.path.expanduser("~/.lax/voices")
os.makedirs(VOICES_DIR, exist_ok=True)


def _detect_gpu() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:
        pass
    return ""


@asynccontextmanager
async def lifespan(app):
    log.info("lax-rvc sidecar starting")
    gpu = _detect_gpu()
    if gpu:
        log.info(f"cuda available: {gpu}")
    else:
        log.warning("no CUDA — RVC will fall back to CPU (very slow)")
    yield
    log.info("lax-rvc sidecar shutdown")


from fastapi import FastAPI, HTTPException, Body  # noqa: E402

app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    return {
        "ok": True,
        "gpu": _detect_gpu() or "cpu-only",
        "tier": "pro",
        # Until ultimate-rvc is wired in, advertise capability honestly.
        "ready": False,
        "reason": "ultimate-rvc not yet integrated (scaffolding only)",
    }


@app.get("/clones")
async def list_clones():
    """List all registered RVC voices on disk. Even untrained entries appear
    so the UI can show training status."""
    out = []
    if os.path.isdir(VOICES_DIR):
        for entry in sorted(os.listdir(VOICES_DIR)):
            meta_path = os.path.join(VOICES_DIR, entry, "rvc-meta.json")
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                out.append({"id": entry, **meta})
            except Exception as e:
                log.warning(f"could not read {entry}: {e}")
    return {"clones": out}


@app.post("/clones")
async def create_clone(payload: dict = Body(...)):
    """Register a new voice (saves the reference audio). Training is a
    separate step — POST /clones/{id}/train kicks it off."""
    raise HTTPException(501, "RVC integration pending — install Python 3.12 + ultimate-rvc")


@app.post("/clones/{voice_id}/train")
async def train_clone(voice_id: str, payload: dict = Body(default={})):
    raise HTTPException(501, "RVC training not yet integrated")


@app.get("/clones/{voice_id}/train/{job_id}")
async def train_status(voice_id: str, job_id: str):
    raise HTTPException(501, "RVC training not yet integrated")


@app.post("/clones/{voice_id}/infer")
async def infer_clone(voice_id: str, payload: dict = Body(...)):
    """Run RVC voice conversion on input PCM. Input: {pcm_b64, sr}.
    Output: {pcm_b64, sr} of converted audio."""
    raise HTTPException(501, "RVC inference not yet integrated")


@app.delete("/clones/{voice_id}")
async def delete_clone(voice_id: str):
    """Remove a voice's models + meta from disk."""
    raise HTTPException(501, "pending")


@app.patch("/clones/{voice_id}")
async def rename_clone(voice_id: str, payload: dict = Body(...)):
    """Update display name on rvc-meta.json."""
    raise HTTPException(501, "pending")


def main():
    import uvicorn
    port = int(os.environ.get("LAX_RVC_PORT", "7009"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
