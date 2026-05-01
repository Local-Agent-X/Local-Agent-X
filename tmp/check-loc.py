import pathlib
for f in ["scripts/test-tier4-smoke.mjs","src/voice/tier4/kokoro-engine.ts","src/voice/tier4/streaming-tts.ts","src/voice/tier4/types.ts"]:
    p = pathlib.Path(f)
    lines = p.read_text(encoding="utf-8").count(chr(10)) + 1
    print(f, "lines:", lines)
