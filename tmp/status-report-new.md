# Voice Tier 4 v2 - status (2026-05-01)

Goal: native ONNX voice path with quality parity vs the Python sidecar,
for both CPU users (priority) and GPU users (opt-in).

## Deliverables

| # | Deliverable     | Status  | Notes |
| - | --------------- | ------- | ----- |
| 1 | CPU STT         | shipped | sherpa-onnx Whisper tiny.en int8 + Zipformer streaming. |
| 2 | CPU TTS         | shipped | Kokoro-82M ONNX q8/cpu via kokoro-js. |
| 3 | GPU TTS opt-in  | shipped | LAX_VOICE_TIER4_DEVICE + safe cpu+q8 fallback. |
| 4 | GPU STT opt-in  | shipped | LAX_VOICE_WHISPER_DEVICE + safe cpu fallback. |

## What changed this round (round 4)

- src/voice/whisper-stream.ts
  - Added LAX_VOICE_WHISPER_DEVICE env var (cpu | cuda | dml | coreml).
  - Extracted buildConfig() helper so the same config shape can be reused
    for the retry pass.
  - GPU EP failures fall back to cpu once; pure-cpu init failures still
    bubble up untouched (no silent swallow when the box has no GPU at all).
  - WhisperTranscriber.runtime: { provider, fellBack } now exposed so
    voice-session can later pipe it into the voice_ready WS event.
- workspace/reports/voice-tier4-v2-status.md updated for round 4 status.

## How to use the GPU opt-ins

    LAX_VOICE_TIER4_DEVICE=dml LAX_VOICE_TIER4_DTYPE=fp16 \
      LAX_VOICE_WHISPER_DEVICE=dml \
      npm start

If either GPU EP fails to bind, the engine still produces audio /
transcripts via cpu and reports fellBack:true on the runtime field.

## Next round candidates

1. Voice-session surface - pipe runtime.provider/fellBack from both TTS
   (kokoro) and STT (whisper) into the voice_ready WS event so the
   browser voice card can show what loaded.
2. Settings UI dropdown - extend Settings -> Voice with tier4 device
   selectors that write through to ~/.lax/settings.json.
3. Smoke test extension - scripts/test-tier4-smoke.mjs currently only
   exercises TTS; add a Whisper round-trip path so GPU-STT regressions
   surface in CI.
