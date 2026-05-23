"""Per-WebSocket-connection state: audio buffer, VAD, pipelined TTS queue."""

import asyncio
import json
import time
from typing import Optional

import numpy as np

from .audio import f32_to_b64_int16
from .clones import synth_via_chatterbox, synth_via_sovits
from .constants import (
    MIC_SR,
    MIN_UTTERANCE_S,
    PARTIAL_INTERVAL_S,
    SILENCE_FRAMES_END,
    SPEECH_FRAMES_START,
    TTS_CHUNK_MS,
    VAD_FRAME,
    VAD_THRESH,
)
from .cuda_bootstrap import log
from .models import _load_tts, _load_vad, _transcribe


class Session:
    """One per WS connection. Holds the audio buffer, VAD state, and the
    TTS pipeline queue. STT/VAD/TTS models are shared at module level."""

    def __init__(self, ws):
        self.ws = ws
        # Audio accumulator (16kHz mono float32)
        self.audio = np.zeros(0, dtype=np.float32)
        # VAD state machine
        self.in_speech = False
        self.consecutive_speech = 0
        self.consecutive_silence = 0
        self.utterance_start_idx = 0
        self.last_partial_t = 0.0
        # Pipelined TTS: each sentence has a Future that resolves when its
        # Kokoro / Chatterbox processing finishes. The streamer consumes
        # them in arrival order so audio chunks reach the browser in order
        # even though processing happens concurrently. Hides per-call
        # synth latency for sentences 2+ in multi-sentence replies.
        self.tts_order: asyncio.Queue = asyncio.Queue()
        self.tts_results: dict = {}      # sentence_id -> asyncio.Future[(samples, sr, prep_ms) | Exception]
        self.tts_in_flight: dict = {}    # sentence_id -> asyncio.Task (prep)
        self.tts_streamer_task: Optional[asyncio.Task] = None
        # Cap concurrent prep tasks so we don't OOM the GPU on long
        # multi-sentence replies. 3 is comfortable on a 12GB 3060.
        self.tts_prep_sem = asyncio.Semaphore(3)
        self.tts_cancel = False

    async def start_tts_worker(self):
        if self.tts_streamer_task is None or self.tts_streamer_task.done():
            self.tts_streamer_task = asyncio.create_task(self._tts_streamer())

    async def stop_tts_worker(self):
        for task in list(self.tts_in_flight.values()):
            task.cancel()
        self.tts_in_flight.clear()
        if self.tts_streamer_task and not self.tts_streamer_task.done():
            self.tts_streamer_task.cancel()
            try:
                await self.tts_streamer_task
            except asyncio.CancelledError:
                pass

    async def _tts_streamer(self):
        """Pulls sentence IDs in arrival order, awaits their prepared audio,
        and streams audio_chunks. Sentences are processed in parallel by
        _prep_one() but emitted in order here."""
        while True:
            sentence_id = await self.tts_order.get()
            if sentence_id is None:
                continue
            fut = self.tts_results.pop(sentence_id, None)
            if fut is None:
                continue
            if self.tts_cancel:
                await self._send({"type": "audio_done", "id": sentence_id, "ms": 0, "cancelled": True})
                continue
            try:
                samples, sample_rate, prep_ms = await fut
            except Exception as e:
                await self._send({"type": "error", "message": f"tts: {e}"})
                await self._send({"type": "audio_done", "id": sentence_id, "ms": prep_ms if isinstance(prep_ms, int) else 0, "cancelled": False})
                continue
            await self._stream_audio(samples, sample_rate, sentence_id, prep_ms)

    async def _prep_one(self, text: str, sentence_id: int, voice: str, speed: float, fut):
        """Generate audio for one sentence. Three voice routing modes:
          * voice == "sv:<id>"  -> GPT-SoVITS clone (trained or zero-shot)
                                   via the SoVITS sidecar (:7012).
          * voice == "cb:<id>"  -> single-stage Chatterbox (Studio tier);
                                   zero-shot fallback when no SoVITS clone exists.
          * else                -> straight Kokoro built-in voice (Lite tier).
        Resolves the Future with (samples, sample_rate, prep_ms_int)."""
        async with self.tts_prep_sem:
            t0 = time.time()
            try:
                if voice.startswith("sv:"):
                    samples, sample_rate = await synth_via_sovits(
                        voice.split(":", 1)[1], text, sentence_id,
                    )
                elif voice.startswith("cb:"):
                    samples, sample_rate = await synth_via_chatterbox(
                        voice.split(":", 1)[1], text, sentence_id,
                    )
                else:
                    loop = asyncio.get_running_loop()
                    tts = _load_tts()
                    samples, sample_rate = await loop.run_in_executor(
                        None,
                        lambda: tts.create(text, voice=voice, speed=speed, lang="en-us"),
                    )
            except Exception as e:
                log.exception(f"tts synth failed for id={sentence_id}")
                if not fut.done():
                    fut.set_exception(e)
                return

            prep_ms = int((time.time() - t0) * 1000)
            if not fut.done():
                fut.set_result((samples, sample_rate, prep_ms))

    async def _stream_audio(self, samples, sample_rate: int, sentence_id: int, prep_ms: int):
        """Emit audio_chunks for already-prepared samples + the audio_done."""
        t0 = time.time()
        if self.tts_cancel:
            await self._send({"type": "audio_done", "id": sentence_id, "ms": prep_ms, "cancelled": True})
            return

        chunk_n = int(sample_rate * (TTS_CHUNK_MS / 1000.0))
        for i in range(0, len(samples), chunk_n):
            if self.tts_cancel:
                break
            chunk = samples[i:i + chunk_n]
            await self._send({
                "type": "audio_chunk",
                "pcm": f32_to_b64_int16(chunk),
                "sr": int(sample_rate),
                "id": sentence_id,
                "final": (i + chunk_n) >= len(samples),
            })
            await asyncio.sleep(0)
        await self._send({
            "type": "audio_done",
            "id": sentence_id,
            "ms": int((time.time() - t0) * 1000),
            "cancelled": self.tts_cancel,
        })

    async def cancel_tts(self):
        self.tts_cancel = True
        for task in list(self.tts_in_flight.values()):
            task.cancel()
        self.tts_in_flight.clear()
        while not self.tts_order.empty():
            try:
                self.tts_order.get_nowait()
            except asyncio.QueueEmpty:
                break
        for fut in self.tts_results.values():
            if not fut.done():
                fut.cancel()
        self.tts_results.clear()
        await asyncio.sleep(0)
        self.tts_cancel = False

    async def queue_tts(self, text: str, sentence_id: int, voice: str, speed: float):
        # Pipelined: kick off prep immediately so it runs concurrently with
        # any prior sentence's playback. Streamer emits results in order
        # via tts_order.
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self.tts_results[sentence_id] = fut
        await self.tts_order.put(sentence_id)
        prep_task = asyncio.create_task(self._prep_one(text, sentence_id, voice, speed, fut))
        self.tts_in_flight[sentence_id] = prep_task
        prep_task.add_done_callback(lambda _t, sid=sentence_id: self.tts_in_flight.pop(sid, None))
        await self.start_tts_worker()

    async def feed_audio(self, pcm_int16: np.ndarray):
        """Append a mic chunk and run VAD on every full 512-sample window."""
        floats = pcm_int16.astype(np.float32) / 32768.0
        self.audio = np.concatenate([self.audio, floats])
        frame_count = (len(self.audio) - self._vad_consumed_until()) // VAD_FRAME
        if frame_count <= 0:
            return
        for _ in range(frame_count):
            base = self._vad_consumed_until()
            frame = self.audio[base:base + VAD_FRAME]
            await self._vad_step(frame)

        now = time.time()
        if self.in_speech and (now - self.last_partial_t) >= PARTIAL_INTERVAL_S:
            self.last_partial_t = now
            await self._emit_partial()

    def _vad_consumed_until(self) -> int:
        return getattr(self, "_vad_consumed_n", 0)

    def _set_vad_consumed(self, n: int):
        self._vad_consumed_n = n

    async def _vad_step(self, frame: np.ndarray):
        # silero-vad's input validator wants a torch tensor even when the
        # underlying inference path is ONNX. We just convert numpy -> torch
        # on the boundary.
        import torch
        vad = _load_vad()
        t = torch.from_numpy(frame)
        prob = float(vad(t, MIC_SR).item())

        speech = prob >= VAD_THRESH
        if speech:
            self.consecutive_speech += 1
            self.consecutive_silence = 0
        else:
            self.consecutive_silence += 1
            self.consecutive_speech = 0

        if not self.in_speech and self.consecutive_speech >= SPEECH_FRAMES_START:
            self.in_speech = True
            # Pre-roll ~300ms for the word onset VAD needed time to confirm
            preroll = int(MIC_SR * 0.3)
            self.utterance_start_idx = max(0, self._vad_consumed_until() - preroll)
            await self._send({"type": "vad_start"})
            self.last_partial_t = time.time()

        elif self.in_speech and self.consecutive_silence >= SILENCE_FRAMES_END:
            self.in_speech = False
            await self._send({"type": "vad_end"})
            await self._emit_final()

        self._set_vad_consumed(self._vad_consumed_until() + VAD_FRAME)

    async def _emit_partial(self):
        if not self.in_speech:
            return
        end_idx = self._vad_consumed_until()
        clip = self.audio[self.utterance_start_idx:end_idx]
        if len(clip) < int(MIN_UTTERANCE_S * MIC_SR):
            return
        loop = asyncio.get_running_loop()
        try:
            text = await loop.run_in_executor(None, lambda: _transcribe(clip))
        except Exception as e:
            log.warning(f"partial stt failed: {e}")
            return
        if text:
            await self._send({"type": "partial", "text": text})

    async def _emit_final(self):
        end_idx = self._vad_consumed_until()
        clip = self.audio[self.utterance_start_idx:end_idx]
        if len(clip) < int(MIN_UTTERANCE_S * MIC_SR):
            return
        loop = asyncio.get_running_loop()
        t0 = time.time()
        try:
            text = await loop.run_in_executor(None, lambda: _transcribe(clip))
        except Exception as e:
            await self._send({"type": "error", "message": f"final stt: {e}"})
            return
        ms = int((time.time() - t0) * 1000)
        # Compact the audio buffer — we don't need previous utterance audio
        self.audio = self.audio[end_idx:]
        self._set_vad_consumed(0)
        self.utterance_start_idx = 0
        await self._send({"type": "final", "text": text, "ms": ms})

    async def reset(self):
        self.audio = np.zeros(0, dtype=np.float32)
        self.in_speech = False
        self.consecutive_speech = 0
        self.consecutive_silence = 0
        self.utterance_start_idx = 0
        self._set_vad_consumed(0)
        await self.cancel_tts()

    async def _send(self, msg: dict):
        try:
            await self.ws.send_text(json.dumps(msg))
        except Exception:
            pass
