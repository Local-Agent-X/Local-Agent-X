import pathlib
for f in ["workspace/reports/voice-tier4-v2-status.md"]:
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
