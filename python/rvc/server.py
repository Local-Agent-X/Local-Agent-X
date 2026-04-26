"""RVC voice-cloning sidecar (Pro tier) — HTTP service on 127.0.0.1:7009.

Runs ultimate-rvc in its own venv (~/.lax/python-rvc/venv/) so the heavy
torch+cu128 stack doesn't conflict with the Lite voice sidecar's
torch+cu121 + onnxruntime-gpu stack.

Architecture:
  Lite voice sidecar (:7008): Whisper STT + Silero VAD + Kokoro TTS
  Pro RVC sidecar    (:7009): ultimate-rvc voice conversion + training

Inference flow when user picks a cloned voice:
  1. Lite sidecar synthesizes the sentence with Kokoro (~150ms)
  2. Lite sidecar POSTs the WAV to /clones/<id>/infer
  3. RVC sidecar runs voice conversion (~0.3-0.5x real-time on RTX 3060)
  4. Returns the converted WAV
  5. Lite sidecar streams it back to the browser as audio_chunks

REST endpoints:
  GET    /healthz                            → {ok, gpu, ready}
  GET    /clones                             → {clones: [{id, name}, ...]}
  POST   /clones                             → upload a .pth (+.index) model
  POST   /clones/from-url                    → download from URL (HF, etc.)
  POST   /clones/{id}/infer                  → audio/wav voice conversion
  DELETE /clones/{id}                        → remove model files
  PATCH  /clones/{id}                        → rename
"""

import base64
import io
import logging
import os
import shutil
import tempfile
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

# ── Redirect ultimate-rvc storage to ~/.lax/rvc/ ──
# Without this, ultimate_rvc.common picks `Path.cwd()` and dumps multi-GB
# of models, audio, temp, config into wherever the sidecar was launched
# from (i.e., into our repo). Set these BEFORE importing ultimate_rvc.
RVC_HOME = os.path.expanduser("~/.lax/rvc")
os.makedirs(RVC_HOME, exist_ok=True)
os.environ.setdefault("URVC_MODELS_DIR", os.path.join(RVC_HOME, "models"))
os.environ.setdefault("URVC_VOICE_MODELS_DIR", os.path.join(RVC_HOME, "models", "rvc", "voice_models"))
os.environ.setdefault("URVC_AUDIO_DIR", os.path.join(RVC_HOME, "audio"))
os.environ.setdefault("URVC_TEMP_DIR", os.path.join(RVC_HOME, "temp"))
os.environ.setdefault("URVC_CONFIG_DIR", os.path.join(RVC_HOME, "config"))
for _d in [
    os.environ["URVC_MODELS_DIR"],
    os.environ["URVC_VOICE_MODELS_DIR"],
    os.environ["URVC_AUDIO_DIR"],
    os.environ["URVC_TEMP_DIR"],
    os.environ["URVC_CONFIG_DIR"],
]:
    os.makedirs(_d, exist_ok=True)

logging.basicConfig(
    level=os.environ.get("LAX_RVC_LOG", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("lax-rvc")


def _detect_gpu() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:
        pass
    return ""


# Lazy import — first import of ultimate_rvc pulls a lot. Defer to first use.
_rvc_loaded = False


def _load_rvc():
    global _rvc_loaded
    if _rvc_loaded:
        return
    log.info("loading ultimate-rvc (first request — ~3-5s)...")
    t0 = time.time()
    # Force imports here so the first inference call doesn't pay the cost.
    import ultimate_rvc.core.generate.speech  # noqa: F401
    import ultimate_rvc.core.manage.models    # noqa: F401
    log.info(f"  ultimate-rvc loaded in {time.time() - t0:.1f}s")
    _rvc_loaded = True


@asynccontextmanager
async def lifespan(app):
    log.info(f"lax-rvc sidecar starting (RVC_HOME={RVC_HOME})")
    gpu = _detect_gpu()
    if gpu:
        log.info(f"cuda available: {gpu}")
    else:
        log.warning("no CUDA — RVC will fall back to CPU (very slow)")
    # Pre-warm so the first user request isn't slow.
    if os.environ.get("LAX_RVC_PRELOAD", "1") == "1":
        try:
            _load_rvc()
        except Exception as e:
            log.exception(f"pre-warm failed (will retry on first request): {e}")
    yield
    log.info("lax-rvc sidecar shutdown")


from fastapi import FastAPI, HTTPException, Body  # noqa: E402
from fastapi.responses import Response  # noqa: E402

app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    return {
        "ok": True,
        "gpu": _detect_gpu() or "cpu-only",
        "tier": "pro",
        "ready": _rvc_loaded,
        "rvc_home": RVC_HOME,
    }


@app.get("/clones")
async def list_clones():
    """List all installed RVC voice models."""
    _load_rvc()
    from ultimate_rvc.core.manage.models import get_voice_model_names
    names = get_voice_model_names()
    return {"clones": [{"id": n, "name": n} for n in names]}


@app.post("/clones")
async def upload_clone(payload: dict = Body(...)):
    """Install an RVC voice model. Body: {name, files_b64} where files_b64
    is a base64-encoded ZIP containing the .pth (and optional .index) files."""
    _load_rvc()
    from ultimate_rvc.core.manage.models import upload_voice_model

    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    files_b64 = payload.get("files_b64") or ""
    if not files_b64:
        raise HTTPException(400, "files_b64 (zipped .pth + .index) required")

    try:
        zip_bytes = base64.b64decode(files_b64)
    except Exception as e:
        raise HTTPException(400, f"files_b64 not valid base64: {e}")

    # Extract zip into a temp dir, then hand the file paths to ultimate-rvc
    extract_dir = Path(tempfile.mkdtemp(prefix=f"rvc-upload-{uuid.uuid4().hex[:6]}-"))
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            zf.extractall(extract_dir)
        # Collect the .pth and .index files (recurse one level)
        files = []
        for p in extract_dir.rglob("*"):
            if p.suffix.lower() in (".pth", ".index"):
                files.append(p)
        if not files:
            raise HTTPException(400, "zip contained no .pth / .index files")
        upload_voice_model(files, name)
        return {"id": name, "name": name, "files": [f.name for f in files]}
    except HTTPException:
        raise
    except Exception as e:
        log.exception("upload failed")
        raise HTTPException(500, f"upload: {e}")
    finally:
        shutil.rmtree(extract_dir, ignore_errors=True)


@app.post("/clones/from-url")
async def download_clone(payload: dict = Body(...)):
    """Install an RVC voice model from a URL (e.g. HuggingFace). Body:
    {name, url}. Useful for pre-trained community models."""
    _load_rvc()
    from ultimate_rvc.core.manage.models import download_voice_model

    name = (payload.get("name") or "").strip()
    url = (payload.get("url") or "").strip()
    if not name or not url:
        raise HTTPException(400, "name and url required")
    try:
        download_voice_model(url, name)
        return {"id": name, "name": name}
    except Exception as e:
        log.exception("download failed")
        raise HTTPException(500, f"download: {e}")


@app.post("/clones/{voice_id}/infer")
async def infer_clone(voice_id: str, payload: dict = Body(...)):
    """Run RVC voice conversion on input PCM. Body: {pcm_b64, sr, ...rvc_opts}.
    Returns audio/wav of the converted speech."""
    _load_rvc()
    from ultimate_rvc.core.generate.speech import convert as rvc_convert
    from ultimate_rvc.core.manage.models import get_voice_model_names

    if voice_id not in get_voice_model_names():
        raise HTTPException(404, f"voice {voice_id!r} not installed")

    pcm_b64 = payload.get("pcm_b64") or ""
    sr = int(payload.get("sr") or 24000)
    if not pcm_b64:
        raise HTTPException(400, "pcm_b64 required")
    n_semitones = int(payload.get("n_semitones") or 0)
    index_rate = float(payload.get("index_rate") or 0.5)
    protect_rate = float(payload.get("protect_rate") or 0.33)

    # Decode incoming PCM (int16) → write a temp WAV → call convert → read back.
    try:
        import numpy as np
        import soundfile as sf
    except ImportError as e:
        raise HTTPException(500, f"dependency missing: {e}")

    pcm_bytes = base64.b64decode(pcm_b64)
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

    work_dir = Path(tempfile.mkdtemp(prefix=f"rvc-infer-{uuid.uuid4().hex[:6]}-"))
    try:
        in_wav = work_dir / "in.wav"
        sf.write(in_wav, samples, sr, subtype="PCM_16")
        t0 = time.time()
        out_path = rvc_convert(
            audio_track=str(in_wav),
            directory=str(work_dir),
            model_name=voice_id,
            n_semitones=n_semitones,
            index_rate=index_rate,
            protect_rate=protect_rate,
        )
        dur_ms = int((time.time() - t0) * 1000)
        log.info(f"infer voice={voice_id} sr={sr} samples={len(samples)} dur={dur_ms}ms")
        # Read converted output and return as audio/wav
        out_bytes = Path(out_path).read_bytes()
        return Response(content=out_bytes, media_type="audio/wav", headers={
            "X-Convert-Ms": str(dur_ms),
        })
    except Exception as e:
        log.exception("infer failed")
        raise HTTPException(500, f"infer: {e}")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@app.delete("/clones/{voice_id}")
async def delete_clone(voice_id: str):
    """Remove a voice model from disk."""
    _load_rvc()
    from ultimate_rvc.core.manage.models import delete_voice_models, get_voice_model_names
    if voice_id not in get_voice_model_names():
        raise HTTPException(404, "not found")
    try:
        delete_voice_models([voice_id])
        return {"ok": True, "deleted": voice_id}
    except Exception as e:
        log.exception("delete failed")
        raise HTTPException(500, str(e))


@app.patch("/clones/{voice_id}")
async def rename_clone(voice_id: str, payload: dict = Body(...)):
    """Rename is a directory move on the model dir. ultimate-rvc doesn't
    expose a rename helper directly, so this is a no-op for now — the
    upload step is where you set the name. Returns 501 to make this
    explicit instead of pretending to succeed."""
    raise HTTPException(501, "rename not implemented — re-upload with the new name")


def main():
    import uvicorn
    port = int(os.environ.get("LAX_RVC_PORT", "7009"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
