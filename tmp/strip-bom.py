with open('src/voice/tier4/kokoro-engine.ts','rb') as f:
    data=f.read()
bom = bytes([0xef,0xbb,0xbf])
# keep only leading BOM (if any), strip embedded ones
prefix = b''
if data.startswith(bom):
    prefix = bom
    data = data[3:]
data = data.replace(bom, b'')
with open('src/voice/tier4/kokoro-engine.ts','wb') as f:
    f.write(prefix + data)
print('cleaned, size now', len(prefix)+len(data))
