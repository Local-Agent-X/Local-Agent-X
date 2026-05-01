import pathlib
for f in ["src/voice/tier4/streaming-tts.ts","src/voice/tier4/types.ts","src/voice/tier4/kokoro-engine.ts","scripts/test-tier4-smoke.mjs"]:
    with open(f,"rb") as h:
        d = h.read()
    bom = bytes([0xef,0xbb,0xbf])
    embedded = 0
    if d.startswith(bom):
        d = d[3:]
    while bom in d:
        d = d.replace(bom, b"", 1)
        embedded += 1
    with open(f,"wb") as h:
        h.write(d)
    print(f, "embedded BOMs stripped:", embedded)
