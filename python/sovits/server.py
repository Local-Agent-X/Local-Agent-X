"""GPT-SoVITS voice-cloning sidecar — HTTP service on 127.0.0.1:7012.

Wraps GPT-SoVITS's `api_v2.py` (running at :7011) with a Chatterbox-style
`/clones` API so the LAX bridge can treat trained voices the same as
Chatterbox voices.

A "clone" = a directory under ~/.lax/voices-sovits/<id>/ containing:
  ref.wav            5-10s reference clip (required, zero-shot anchor)
  meta.json          {name, prompt_text, sovits_pth, gpt_ckpt, created_at}
  sovits.pth         (optional) fine-tuned SoVITS weights, symlinked
  gpt.ckpt           (optional) fine-tuned GPT weights, symlinked

Endpoints:
  GET    /healthz                          → {ok, ready, sr, api_v2_url}
  GET    /clones                           → {clones: [{id, name, fine_tuned, created_at}, ...]}
  POST   /clones                           → register a clone (multipart: ref.wav + meta)
  POST   /clones/{id}/synth                → audio/wav (binary), body: {text}
  DELETE /clones/{id}                      → remove clone dir
  PATCH  /clones/{id}                      → update name / prompt_text / weights paths

Synth flow:
  1. Look up clone, validate ref.wav exists
  2. If clone has fine-tuned weights: POST /set_sovits_weights + /set_gpt_weights to api_v2
     (cached — only re-set if different from currently loaded)
  3. POST /tts to api_v2 with ref_audio_path + prompt_text + text
  4. Stream WAV back
"""

import asyncio
import io
import json
import logging
import os
import subprocess
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

logging.basicConfig(
    level=os.environ.get("LAX_SOVITS_LOG", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("lax-sovits")

VOICES_DIR = Path(os.path.expanduser("~/.lax/voices-sovits"))
VOICES_DIR.mkdir(parents=True, exist_ok=True)

API_V2_URL = os.environ.get("LAX_SOVITS_API_V2", "http://127.0.0.1:7011")
SAMPLE_RATE = 32000

# Track currently-loaded weights on api_v2 so we don't reload every synth.
_state = {"sovits_pth": None, "gpt_ckpt": None}


def _meta_path(clone_id: str) -> Path:
    return VOICES_DIR / clone_id / "meta.json"


def _ref_path(clone_id: str) -> Path:
    return VOICES_DIR / clone_id / "ref.wav"


def _read_meta(clone_id: str) -> dict | None:
    p = _meta_path(clone_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _list_clones() -> list[dict]:
    out = []
    for d in sorted(VOICES_DIR.iterdir()):
        if not d.is_dir():
            continue
        meta = _read_meta(d.name)
        if not meta or not _ref_path(d.name).exists():
            continue
        out.append({
            "id": d.name,
            "name": meta.get("name", d.name),
            "fine_tuned": bool(meta.get("sovits_pth") and meta.get("gpt_ckpt")),
            "created_at": meta.get("created_at", 0),
        })
    return out


async def _ensure_weights(client: httpx.AsyncClient, meta: dict) -> None:
    """Set fine-tuned SoVITS+GPT weights on api_v2 if this clone has them
    and they aren't already loaded."""
    sov = meta.get("sovits_pth")
    gpt = meta.get("gpt_ckpt")
    if sov and sov != _state["sovits_pth"]:
        log.info("loading sovits weights: %s", sov)
        r = await client.get(f"{API_V2_URL}/set_sovits_weights", params={"weights_path": sov})
        if r.status_code != 200:
            raise HTTPException(502, f"set_sovits_weights failed: {r.text}")
        _state["sovits_pth"] = sov
    if gpt and gpt != _state["gpt_ckpt"]:
        log.info("loading gpt weights: %s", gpt)
        r = await client.get(f"{API_V2_URL}/set_gpt_weights", params={"weights_path": gpt})
        if r.status_code != 200:
            raise HTTPException(502, f"set_gpt_weights failed: {r.text}")
        _state["gpt_ckpt"] = gpt


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Spawn the upstream GPT-SoVITS api_v2 server we proxy to. Without this
    # the wrapper boots fine but every synth fails because api_v2 isn't
    # running. We start it as a subprocess scoped to our lifetime — when
    # the wrapper exits we tear it down too.
    api_v2_proc = None
    api_v2_port = API_V2_URL.rsplit(":", 1)[-1]
    repo_dir = os.path.expanduser("~/.lax/sovits/repo")
    api_v2_script = os.path.join(repo_dir, "api_v2.py")

    # Skip spawn if something is already on the port (manual launch / tests).
    already_up = False
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(f"{API_V2_URL}/docs")
            already_up = r.status_code == 200
    except Exception:
        already_up = False

    if already_up:
        log.info("api_v2 already running at %s — using existing process", API_V2_URL)
    elif not os.path.exists(api_v2_script):
        log.error("api_v2.py not found at %s — synth will fail", api_v2_script)
    else:
        log.info("spawning api_v2 (port %s, cwd %s)...", api_v2_port, repo_dir)
        api_v2_proc = subprocess.Popen(
            [sys.executable, api_v2_script, "-a", "127.0.0.1", "-p", api_v2_port],
            cwd=repo_dir,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        # Drain stdout to our log so users can see api_v2's progress.
        async def _drain():
            assert api_v2_proc is not None and api_v2_proc.stdout is not None
            loop = asyncio.get_event_loop()
            while api_v2_proc.poll() is None:
                line = await loop.run_in_executor(None, api_v2_proc.stdout.readline)
                if not line:
                    break
                log.info("[api_v2] %s", line.rstrip())
        asyncio.create_task(_drain())

        # Do NOT block startup on api_v2's cold-load. GPT-SoVITS takes 30-120s
        # to load weights + build its CUDA context; if we awaited that here the
        # wrapper wouldn't bind :7012 for the whole window, and the Node process
        # manager (startTierAndWait's health probe + the 60s orphan reaper) would
        # see a non-listening port and kill the still-loading wrapper. Yield now
        # so :7012 comes up in seconds; /healthz reports api_v2's real readiness,
        # and /synth (120s client timeout) waits for it on the first request.
        log.info("api_v2 spawned (pid=%s); loading in background — synth waits until ready", api_v2_proc.pid)

    try:
        yield
    finally:
        if api_v2_proc and api_v2_proc.poll() is None:
            log.info("stopping api_v2 (pid=%s)", api_v2_proc.pid)
            try:
                api_v2_proc.terminate()
                try:
                    api_v2_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    api_v2_proc.kill()
            except Exception as e:
                log.warning("api_v2 shutdown error: %s", e)


app = FastAPI(lifespan=lifespan, title="LAX SoVITS sidecar")


@app.get("/healthz")
async def healthz():
    api_v2_ok = False
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(f"{API_V2_URL}/docs")
            api_v2_ok = r.status_code == 200
    except Exception:
        pass
    return {
        "ok": True,
        "ready": api_v2_ok,
        "sr": SAMPLE_RATE,
        "api_v2_url": API_V2_URL,
        "voices_dir": str(VOICES_DIR),
        "clone_count": len(_list_clones()),
    }


@app.get("/clones")
async def list_clones():
    return {"clones": _list_clones()}


@app.post("/clones")
async def create_clone(req: Request):
    """Register a clone. Body is JSON:
       {name, prompt_text, ref_wav_b64, sovits_pth?, gpt_ckpt?}
    ref_wav_b64 is the reference clip base64-encoded.
    sovits_pth / gpt_ckpt are absolute paths if fine-tuned.
    """
    import base64
    body = await req.json()
    name = (body.get("name") or "").strip() or "Untitled"
    prompt_text = (body.get("prompt_text") or "").strip()
    ref_b64 = body.get("ref_wav_b64") or ""
    sovits_pth = body.get("sovits_pth") or None
    gpt_ckpt = body.get("gpt_ckpt") or None
    if not ref_b64:
        raise HTTPException(400, "ref_wav_b64 required")
    if not prompt_text:
        raise HTTPException(400, "prompt_text required (transcript of ref clip)")

    clone_id = uuid.uuid4().hex[:12]
    cdir = VOICES_DIR / clone_id
    cdir.mkdir(parents=True, exist_ok=True)
    try:
        wav_bytes = base64.b64decode(ref_b64)
    except Exception:
        raise HTTPException(400, "ref_wav_b64 is not valid base64")
    ref_p = _ref_path(clone_id)
    ref_p.write_bytes(wav_bytes)
    # Validate it's actually a readable WAV in 3-10s range
    try:
        info = sf.info(str(ref_p))
        dur = info.frames / info.samplerate
        if dur < 3 or dur > 10:
            raise HTTPException(400, f"ref clip must be 3-10s, got {dur:.1f}s")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"ref clip not readable: {e}")

    meta = {
        "id": clone_id,
        "name": name,
        "prompt_text": prompt_text,
        "sovits_pth": sovits_pth,
        "gpt_ckpt": gpt_ckpt,
        "created_at": int(time.time()),
    }
    _meta_path(clone_id).write_text(json.dumps(meta, indent=2), encoding="utf-8")
    log.info("created clone %s (%s, fine_tuned=%s)", clone_id, name, bool(sovits_pth and gpt_ckpt))
    return JSONResponse({"id": clone_id, "name": name, "fine_tuned": bool(sovits_pth and gpt_ckpt)})


@app.patch("/clones/{clone_id}")
async def patch_clone(clone_id: str, req: Request):
    meta = _read_meta(clone_id)
    if not meta:
        raise HTTPException(404, "clone not found")
    body = await req.json()
    for k in ("name", "prompt_text", "sovits_pth", "gpt_ckpt"):
        if k in body:
            meta[k] = body[k]
    _meta_path(clone_id).write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return {"ok": True, "id": clone_id}


@app.delete("/clones/{clone_id}")
async def delete_clone(clone_id: str):
    cdir = VOICES_DIR / clone_id
    if not cdir.exists():
        raise HTTPException(404, "clone not found")
    for p in cdir.iterdir():
        try: p.unlink()
        except Exception: pass
    try: cdir.rmdir()
    except Exception: pass
    return {"ok": True, "id": clone_id}


@app.post("/clones/{clone_id}/synth")
async def synth_clone(clone_id: str, req: Request):
    meta = _read_meta(clone_id)
    if not meta:
        raise HTTPException(404, "clone not found")
    if not _ref_path(clone_id).exists():
        raise HTTPException(404, "clone ref.wav missing")

    body = await req.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text required")

    async with httpx.AsyncClient(timeout=120.0) as client:
        await _ensure_weights(client, meta)
        tts_req = {
            "text": text,
            "text_lang": "en",
            "ref_audio_path": str(_ref_path(clone_id)),
            "prompt_text": meta["prompt_text"],
            "prompt_lang": "en",
            "text_split_method": "cut0",
            "media_type": "wav",
            "streaming_mode": False,
        }
        r = await client.post(f"{API_V2_URL}/tts", json=tts_req)
        if r.status_code != 200:
            raise HTTPException(r.status_code, f"api_v2 /tts failed: {r.text[:300]}")
        return Response(content=r.content, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("LAX_SOVITS_PORT", "7012"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
