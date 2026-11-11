"""A cancel while the streamer waits on a sentence must not silence later replies.

Runs the sidecar's real Session with synthesis stubbed out (no model, no GPU).
Exit 0 when the reply after the cancel streams audio, 1 when it does not.
Driven by src/voice/sidecar-tts-cancel.test.ts with the voice venv's Python.

2026-11-11: the user talked over a reply while the streamer was waiting on one
of its sentences. The cancel stopped that sentence's synthesis but not the
result the streamer held, so the streamer waited forever and every later reply
was queued and never spoken.
"""
import asyncio
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from _server import session as S  # noqa: E402


async def main() -> int:
    sent = []
    sess = S.Session(ws=None)

    async def record(msg):
        sent.append(msg)

    async def synth(text, voice, speed):
        await asyncio.sleep(0.5 if text == "slow" else 0.01)
        return np.zeros(2400, dtype=np.float32), 24000

    sess._send = record
    sess._synth_kokoro = synth

    await sess.queue_tts("slow", 1, "am_onyx", 1.0)
    await asyncio.sleep(0.05)          # the streamer has taken id 1 and waits on it
    await sess.cancel_tts()            # the user talks over the reply
    await sess.queue_tts("next reply", 2, "am_onyx", 1.0)
    await asyncio.sleep(1.0)

    played = [m for m in sent if m.get("type") == "audio_chunk" and m.get("id") == 2]
    await sess.stop_tts_worker()
    print(f"next reply audio chunks: {len(played)}")
    return 0 if played else 1


sys.exit(asyncio.run(main()))
