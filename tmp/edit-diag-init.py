import pathlib
p = pathlib.Path("src/voice/tier4/streaming-tts.ts")
src = p.read_text(encoding="utf-8")
old = """    diag: {
      modelId: cfg.modelId,
      dtype: cfg.dtype,
      device: cfg.device,
      loadMs: 0,
      firstAudioMs: null,
      totalSentences: 0,
      cancelledSentences: 0,
    },"""
new = """    diag: {
      modelId: cfg.modelId,
      dtype: cfg.dtype,
      device: cfg.device,
      loadMs: 0,
      firstAudioMs: null,
      totalSentences: 0,
      cancelledSentences: 0,
      fellBack: false,
    },"""
assert old in src, "diag anchor missing"
src = src.replace(old, new, 1)
p.write_text(src, encoding="utf-8")
print("diag init updated")
