import pathlib

src = pathlib.Path('tmp/status-report-new.md').read_text(encoding='utf-8')
out = pathlib.Path('workspace/reports/voice-tier4-v2-status.md')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(src, encoding='utf-8')
print(f"wrote {len(src)} bytes to {out}")
