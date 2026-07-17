"""Voice-clone TTS routing: the Chatterbox (Studio) sidecar.

An HTTP sidecar on localhost; this module wraps the round-trip
and audio normalization (mono float32, target sample rate)."""

import io
import os
import re

import numpy as np

from .cuda_bootstrap import log

# clone_id is interpolated into the sidecar URL path; restrict it to an
# unambiguous charset so it can't inject path segments, query strings, or an
# alternate host/authority (SSRF / path traversal against the local sidecars).
_CLONE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _safe_clone_id(clone_id: str) -> str:
    if not isinstance(clone_id, str) or not _CLONE_ID_RE.match(clone_id):
        raise ValueError(f"invalid clone_id: {clone_id!r}")
    return clone_id


async def synth_via_chatterbox(clone_id: str, text: str, sentence_id: int):
    """Studio tier: single-stage Chatterbox TTS via reference clip.
    Returns (samples_float32, sample_rate). Raises on failure so caller
    can mark the Future as errored."""
    import httpx
    import soundfile as sf

    cb_port = os.environ.get("LAX_CHATTERBOX_PORT", "7010")
    url = f"http://127.0.0.1:{cb_port}/clones/{_safe_clone_id(clone_id)}/synth"
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
