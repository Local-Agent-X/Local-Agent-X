"""Voice-clone TTS routing: Chatterbox (Studio) and GPT-SoVITS sidecars.

Both are HTTP sidecars on localhost; this module wraps the round-trip
and audio normalization (mono float32, target sample rate)."""

import io
import os
from math import gcd

import numpy as np

from .cuda_bootstrap import log


async def synth_via_chatterbox(clone_id: str, text: str, sentence_id: int):
    """Studio tier: single-stage Chatterbox TTS via reference clip.
    Returns (samples_float32, sample_rate). Raises on failure so caller
    can mark the Future as errored."""
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


async def synth_via_sovits(clone_id: str, text: str, sentence_id: int):
    """GPT-SoVITS sidecar at :7012. Native output is 32 kHz mono WAV.
    Resampled to 24 kHz to match the browser playback worklet's fixed
    rate. Without this resample the audio plays ~33% too fast and the
    pitch is shifted up. Returns (samples_float32, 24000). Raises on failure."""
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
