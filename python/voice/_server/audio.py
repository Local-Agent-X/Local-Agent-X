"""PCM <-> base64 helpers for the WebSocket protocol."""

import base64

import numpy as np


def b64_to_int16(b64: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype=np.int16)


def f32_to_b64_int16(samples: np.ndarray) -> str:
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    return base64.b64encode(pcm.tobytes()).decode("ascii")
