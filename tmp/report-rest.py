import pathlib
NL = chr(10)
extra = """
## What changed this round (round 4)

- src/voice/tier4/kokoro-engine.ts
  - Added env-var device/dtype overrides (LAX_VOICE_TIER4_DEVICE,
    LAX_VOICE_TIER4_DTYPE).
  - Wrapped KokoroTTS.from_pretrained in try/catch; on non-cpu EP failure
    we fall back to cpu+q8 once and set fellBack=true.
  - New engine.runtime field exposes the device/dtype that loaded.
- src/voice/tier4/streaming-tts.ts
  - Diag snapshot reflects real runtime device/dtype + fellBack.
- src/voice/tier4/types.ts
  - Tier4DiagSnapshot.fellBack: boolean added.
- scripts/test-tier4-smoke.mjs
  - New --dtype flag, prints runtime info on completion.

## How to use the GPU opt-in

    LAX_VOICE_TIER4_DEVICE=dml LAX_VOICE_TIER4_DTYPE=fp16 npm start
    npx tsx scripts/test-tier4-smoke.mjs --device dml --dtype fp16

If the GPU EP fails to bind, the engine still produces audio via cpu+q8
and the diag snapshot reports fellBack:true so a UI can flag the issue.

## Next round candidates

1. GPU STT opt-in - whisper-stream.ts hardcodes provider:cpu. Add
   override via LAX_VOICE_WHISPER_DEVICE mirroring TTS opt-in.
2. Voice-session surface - pipe diag.device/dtype/fellBack into the
   voice_ready WS event so the browser voice card can show what loaded.
3. Settings UI dropdown - extend Settings -> Voice with a tier4 device
   selector that writes through to ~/.lax/settings.json.
"""
p = pathlib.Path("workspace/reports/voice-tier4-v2-status.md")
p.write_text(p.read_text(encoding="utf-8") + extra, encoding="utf-8")
print("appended; total bytes:", p.stat().st_size)
