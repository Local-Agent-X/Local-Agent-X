"""End-to-end smoke test: Kokoro generates a sentence in the Lite venv,
posts it to the RVC sidecar at :7009 for voice conversion, saves the
result. Validates the full pipeline is healthy before wiring it into
the live voice flow.

Usage:
  ~/.lax/python-voice/venv/Scripts/python.exe python/rvc/_smoke.py [voice_id]
"""

import base64
import os
import sys
import time
from pathlib import Path

import numpy as np  # noqa: E402
import requests
import soundfile as sf

VOICE_ID = sys.argv[1] if len(sys.argv) > 1 else "TomHolland"
TEXT = "Hello there. This is a quick smoke test of the voice cloning pipeline."
OUT_WAV = Path("/tmp/rvc-smoke.wav")
OUT_CONVERTED = Path("/tmp/rvc-smoke-converted.wav")

# 1) Generate a Kokoro WAV (running this in the Lite venv that already has kokoro_onnx)
print(f"[1/3] Generating Kokoro audio: {TEXT!r}")
from kokoro_onnx import Kokoro
model_path = os.path.expanduser("~/.lax/python-voice/kokoro/model.onnx")
voices_path = os.path.expanduser("~/.lax/python-voice/kokoro/voices.bin")
kokoro = Kokoro(model_path=model_path, voices_path=voices_path)
samples, sr = kokoro.create(TEXT, voice="am_michael", speed=1.0, lang="en-us")
sf.write(OUT_WAV, samples, sr, subtype="PCM_16")
print(f"  Kokoro: {len(samples)} samples @ {sr}Hz -> {OUT_WAV} ({OUT_WAV.stat().st_size} bytes)")

# 2) Convert via RVC sidecar
print(f"[2/3] Converting through RVC ({VOICE_ID}) ...")
pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
t0 = time.time()
r = requests.post(
    f"http://127.0.0.1:7009/clones/{VOICE_ID}/infer",
    json={"pcm_b64": base64.b64encode(pcm).decode("ascii"), "sr": int(sr)},
    timeout=120,
)
r.raise_for_status()
OUT_CONVERTED.write_bytes(r.content)
print(f"  RVC: {time.time() - t0:.2f}s end-to-end, {len(r.content)} bytes -> {OUT_CONVERTED}")
print(f"  X-Convert-Ms: {r.headers.get('X-Convert-Ms')}")

# 3) Sanity-check the output
print(f"[3/3] Reading converted WAV...")
out_samples, out_sr = sf.read(OUT_CONVERTED)
print(f"  Output: {len(out_samples)} samples @ {out_sr}Hz, peak={np.abs(out_samples).max():.3f}")
print()
print(f"PASS — converted audio is at: {OUT_CONVERTED}")
print(f"      original Kokoro audio is at: {OUT_WAV}")
print()
print(f"Play with:")
print(f'  start "" "{OUT_WAV}"')
print(f'  start "" "{OUT_CONVERTED}"')
