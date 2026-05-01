import pathlib
p = pathlib.Path("src/voice/tier4/streaming-tts.ts")
src = p.read_text(encoding="utf-8")
old = """  state.engine = await createKokoroEngine({
    config: cfg,
    onLoad: (ms) => { state.diag.loadMs = ms; },
  });"""
new = """  state.engine = await createKokoroEngine({
    config: cfg,
    onLoad: (ms) => { state.diag.loadMs = ms; },
  });
  // Engine may fall back to cpu+q8 if a GPU EP fails to bind. Reflect the
  // actual runtime in the diag so the UI / smoke test shows what loaded.
  state.diag.device = state.engine.runtime.device;
  state.diag.dtype = state.engine.runtime.dtype;
  state.diag.fellBack = state.engine.runtime.fellBack;"""
assert old in src, "anchor missing"
src = src.replace(old, new, 1)
p.write_text(src, encoding="utf-8")
print("streaming-tts updated")
