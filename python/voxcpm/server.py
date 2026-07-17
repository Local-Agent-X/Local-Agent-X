"""VoxCPM voice-cloning sidecar — HTTP service on 127.0.0.1:7013.

Runs OpenBMB's VoxCPM2 in its own venv (~/.lax/python-voxcpm/venv/).
Primary clone engine (picked over Chatterbox in the 2026-07 listening
bake-off); Chatterbox (:7010) stays as the backup tier.

Inference flow when the user picks a VoxCPM voice:
  1. Lite sidecar receives `tts` cmd with voice="vx:<id>"
  2. Lite sidecar POSTs the TEXT to /clones/<id>/synth
  3. VoxCPM synthesizes from text using the saved reference clip + its
     transcript (VoxCPM conditions on both — that's why every clone
     stores ref.txt alongside ref.wav)
  4. Returns WAV (48kHz mono PCM16; Lite resamples to the 24kHz worklet)

REST endpoints (same contract as the Chatterbox sidecar):
  GET    /healthz                → {ok, gpu, ready, sr}
  GET    /clones                 → {clones: [{id, name, duration_s}, ...]}
  POST   /clones                 → register a reference clip (auto-transcribes
                                   unless prompt_text is supplied)
  POST   /clones/{id}/synth      → audio/wav (binary), body: {text}
  DELETE /clones/{id}            → remove clone
  PATCH  /clones/{id}            → rename (updates meta.json)

Reference clips live at ~/.lax/voices-voxcpm/<id>/ref.wav + ref.txt + meta.json.
"""

import io
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

logging.basicConfig(
    level=os.environ.get("LAX_VOXCPM_LOG", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("lax-voxcpm")

VOICES_DIR = os.path.expanduser("~/.lax/voices-voxcpm")
os.makedirs(VOICES_DIR, exist_ok=True)

# Where the Chatterbox backup tier keeps its clones. Their ref.wav clips are
# directly usable here (we auto-transcribe), so on first boot we import them —
# the user's existing voices work on the new primary engine without re-upload.
CHATTERBOX_VOICES_DIR = os.path.expanduser("~/.lax/voices-chatterbox")


def _detect_gpu() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:
        pass
    return ""


_model = None
_whisper = None


def _load_model():
    """Returns the loaded VoxCPM model. First call downloads weights (~2GB)
    and takes ~15-20s; subsequent calls are instant."""
    global _model
    if _model is not None:
        return _model
    from voxcpm import VoxCPM
    t0 = time.time()
    last_err = None
    for model_id in ("openbmb/VoxCPM2", "openbmb/VoxCPM-0.5B"):
        try:
            _model = VoxCPM.from_pretrained(model_id)
            log.info(f"loaded {model_id} in {time.time() - t0:.1f}s "
                     f"(sr={_model.tts_model.sample_rate})")
            return _model
        except Exception as e:
            last_err = e
            log.warning(f"could not load {model_id}: {e}")
    raise RuntimeError(f"no VoxCPM model loadable: {last_err}")


def _transcribe(wav_path: str) -> str:
    """Transcript for a reference clip (VoxCPM conditions on prompt text).
    CPU int8 on purpose: a 10-30s clip takes seconds, and keeping whisper off
    the GPU leaves the VRAM to VoxCPM."""
    global _whisper
    from faster_whisper import WhisperModel
    if _whisper is None:
        _whisper = WhisperModel("base.en", device="cpu", compute_type="int8")
    segments, _info = _whisper.transcribe(wav_path)
    return " ".join(s.text.strip() for s in segments).strip()


# ── Reference-clip storage ────────────────────────────────────────────────

# voice_id is interpolated into a filesystem path under VOICES_DIR; reject
# anything but an unambiguous slug (path traversal guard — same contract as
# the Chatterbox sidecar).
_VOICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _is_safe_voice_id(voice_id: object) -> bool:
    return isinstance(voice_id, str) and bool(_VOICE_ID_RE.match(voice_id))


def _voice_dir(voice_id: str) -> Path:
    if not _is_safe_voice_id(voice_id):
        raise HTTPException(400, f"invalid voice id: {voice_id!r}")
    return Path(VOICES_DIR) / voice_id


def _ref_path(voice_id: str) -> Path:
    return _voice_dir(voice_id) / "ref.wav"


def _ref_text_path(voice_id: str) -> Path:
    return _voice_dir(voice_id) / "ref.txt"


def _meta_path(voice_id: str) -> Path:
    return _voice_dir(voice_id) / "meta.json"


def _list_clones() -> list:
    out = []
    if not os.path.isdir(VOICES_DIR):
        return out
    for entry in sorted(os.listdir(VOICES_DIR)):
        if not _is_safe_voice_id(entry):
            continue
        if not (_meta_path(entry).is_file() and _ref_path(entry).is_file()
                and _ref_text_path(entry).is_file()):
            continue
        try:
            data = json.loads(_meta_path(entry).read_text(encoding="utf-8"))
            out.append({
                "id": entry,
                "name": data.get("name", entry),
                "duration_s": data.get("duration_s", 0),
                "created_at": data.get("created_at", 0),
            })
        except Exception as e:
            log.warning(f"could not read clone {entry}: {e}")
    return out


def _register_clone(voice_id: str, name: str, samples, sr: int, prompt_text: str = ""):
    """Write ref.wav + ref.txt + meta.json for one clone. Transcribes when no
    prompt_text is given. Returns the meta dict."""
    import soundfile as sf
    d = _voice_dir(voice_id)
    d.mkdir(parents=True, exist_ok=True)
    sf.write(_ref_path(voice_id), samples, int(sr), subtype="PCM_16")
    text = (prompt_text or "").strip() or _transcribe(str(_ref_path(voice_id)))
    _ref_text_path(voice_id).write_text(text, encoding="utf-8")
    duration = len(samples) / sr
    meta = {
        "name": name,
        "created_at": int(time.time()),
        "duration_s": round(duration, 2),
    }
    _meta_path(voice_id).write_text(json.dumps(meta), encoding="utf-8")
    return meta


def _import_marker() -> Path:
    return Path(VOICES_DIR) / ".chatterbox-imported"


def _import_chatterbox_refs():
    """One-time import of Chatterbox reference clips as VoxCPM clones (the
    marker makes it once-ever so deleting an imported clone doesn't resurrect
    it). Per-clone failures are non-fatal."""
    if _import_marker().exists() or not os.path.isdir(CHATTERBOX_VOICES_DIR):
        return
    import soundfile as sf
    imported = 0
    for entry in sorted(os.listdir(CHATTERBOX_VOICES_DIR)):
        if not _is_safe_voice_id(entry):
            continue
        src_ref = Path(CHATTERBOX_VOICES_DIR) / entry / "ref.wav"
        if not src_ref.is_file() or _voice_dir(entry).is_dir():
            continue
        name = entry
        try:
            src_meta = Path(CHATTERBOX_VOICES_DIR) / entry / "meta.json"
            if src_meta.is_file():
                name = json.loads(src_meta.read_text(encoding="utf-8")).get("name") or entry
        except Exception:
            pass
        try:
            samples, sr = sf.read(str(src_ref))
            if samples.ndim > 1:
                samples = samples.mean(axis=1)
            _register_clone(entry, name, samples, int(sr))
            imported += 1
            log.info(f"imported chatterbox clone {entry!r} '{name}' -> voxcpm")
        except Exception as e:
            log.warning(f"could not import chatterbox clone {entry!r}: {e}")
    try:
        _import_marker().write_text(str(int(time.time())), encoding="utf-8")
    except Exception as e:
        log.warning(f"could not write chatterbox import marker: {e}")
    if imported:
        log.info(f"imported {imported} chatterbox clone(s) as VoxCPM clones")


@asynccontextmanager
async def lifespan(app):
    log.info("lax-voxcpm sidecar starting")
    gpu = _detect_gpu()
    if gpu:
        log.info(f"cuda available: {gpu}")
    else:
        log.warning("no CUDA — VoxCPM will fall back to CPU (slow)")
    try:
        _import_chatterbox_refs()
    except Exception as e:
        log.warning(f"chatterbox import pass failed (non-fatal): {e}")
    if os.environ.get("LAX_VOXCPM_PRELOAD", "1") == "1":
        try:
            _load_model()
        except Exception as e:
            log.exception(f"pre-warm failed (will retry on first request): {e}")
        # Burn the first-generate warm-up at boot so the user's first real
        # request hits the warm path (same rationale as the Chatterbox tier).
        if _model is not None and os.environ.get("LAX_VOXCPM_PREWARM_SYNTH", "1") == "1":
            clones = _list_clones()
            if clones:
                try:
                    cid = clones[0]["id"]
                    log.info(f"  pre-warm synth using {cid!r}...")
                    t0 = time.time()
                    _model.generate(
                        text="Warming up the model.",
                        prompt_wav_path=str(_ref_path(cid)),
                        prompt_text=_ref_text_path(cid).read_text(encoding="utf-8"),
                    )
                    log.info(f"  pre-warm synth done in {time.time() - t0:.1f}s")
                except Exception as e:
                    log.warning(f"pre-warm synth failed (non-fatal): {e}")
    yield
    log.info("lax-voxcpm sidecar shutdown")


from fastapi import FastAPI, HTTPException, Body  # noqa: E402
from fastapi.responses import Response  # noqa: E402

app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    sr = _model.tts_model.sample_rate if _model is not None else 0
    return {
        "ok": True,
        "gpu": _detect_gpu() or "cpu-only",
        "tier": "studio-vox",
        "ready": _model is not None,
        "sr": sr,
        "voices_dir": VOICES_DIR,
    }


@app.get("/clones")
async def list_clones():
    return {"clones": _list_clones()}


@app.post("/clones")
async def upload_clone(payload: dict = Body(...)):
    """Register a reference clip (10-30s clean speech). Body:
    {name, audio_b64, id?, prompt_text?}. prompt_text is the clip's
    transcript; omitted → transcribed automatically."""
    import base64
    import soundfile as sf

    name = (payload.get("name") or "").strip() or "Untitled Voice"
    audio_b64 = payload.get("audio_b64") or ""
    if not audio_b64:
        raise HTTPException(400, "audio_b64 required")
    voice_id = (payload.get("id") or "").strip() or uuid.uuid4().hex[:12]

    try:
        wav_bytes = base64.b64decode(audio_b64)
    except Exception as e:
        raise HTTPException(400, f"audio_b64 not valid base64: {e}")
    try:
        samples, sr = sf.read(io.BytesIO(wav_bytes))
    except Exception as e:
        raise HTTPException(400, f"could not decode audio: {e}")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    duration = len(samples) / sr
    if duration < 3:
        raise HTTPException(400, f"reference too short ({duration:.1f}s); 10-30s recommended")
    if duration > 60:
        raise HTTPException(400, f"reference too long ({duration:.1f}s); trim to 10-30s for best results")

    meta = _register_clone(voice_id, name, samples, int(sr), payload.get("prompt_text", ""))
    log.info(f"registered voxcpm clone {voice_id} '{name}' ({duration:.1f}s)")
    return {"id": voice_id, **meta}


@app.post("/clones/{voice_id}/synth")
async def synth_with_clone(voice_id: str, payload: dict = Body(...)):
    """Synthesize text using the saved reference clip + transcript.
    Body: {text}. Returns audio/wav (binary, 48kHz mono PCM16)."""
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text required")
    ref = _ref_path(voice_id)
    ref_txt = _ref_text_path(voice_id)
    if not ref.is_file() or not ref_txt.is_file():
        raise HTTPException(404, f"clone {voice_id!r} not found")

    model = _load_model()
    t0 = time.time()
    try:
        wav = model.generate(
            text=text,
            prompt_wav_path=str(ref),
            prompt_text=ref_txt.read_text(encoding="utf-8"),
        )
    except Exception as e:
        log.exception(f"synth failed for voice={voice_id}")
        raise HTTPException(500, f"synth: {e}")
    synth_ms = int((time.time() - t0) * 1000)

    import soundfile as sf
    if hasattr(wav, "cpu"):
        wav = wav.cpu().numpy()
    if wav.ndim > 1:
        wav = wav.squeeze()
    sr = int(model.tts_model.sample_rate)
    buf = io.BytesIO()
    sf.write(buf, wav.astype("float32"), sr, subtype="PCM_16", format="WAV")
    log.info(f"synth voice={voice_id} text_len={len(text)} samples={len(wav)}@{sr}Hz {synth_ms}ms")
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
    log.info(f"renamed voxcpm clone {voice_id} -> '{name}'")
    return {"id": voice_id, "name": name}


def main():
    import uvicorn
    port = int(os.environ.get("LAX_VOXCPM_PORT", "7013"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
