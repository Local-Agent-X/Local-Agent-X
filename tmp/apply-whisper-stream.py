import pathlib

new_content = pathlib.Path('tmp/whisper-stream.ts.new').read_text(encoding='utf-8')
out = pathlib.Path('src/voice/whisper-stream.ts')
out.write_text(new_content, encoding='utf-8')
print(f"wrote {len(new_content)} bytes to {out}")
