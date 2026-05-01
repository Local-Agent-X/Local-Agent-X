import pathlib
for fn in ['src/voice/whisper-stream.ts', 'workspace/reports/voice-tier4-v2-status.md']:
    b = pathlib.Path(fn).read_bytes()
    bom = b.startswith(b'\xef\xbb\xbf')
    print(fn, 'BOM' if bom else 'clean', 'bytes', len(b))
