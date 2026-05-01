import pathlib
p = pathlib.Path("src/voice/tier4/kokoro-engine.ts")
src = p.read_text(encoding="utf-8")
old = """  const cfg = {
    ...TIER4_DEFAULTS,
    ...{ device: envDevice(), dtype: envDtype() },
    ...init.config,
  };"""
new = """  const envOverrides: Partial<Tier4Config> = {};
  const ed = envDevice(); if (ed) envOverrides.device = ed;
  const et = envDtype(); if (et) envOverrides.dtype = et;
  const cfg = { ...TIER4_DEFAULTS, ...envOverrides, ...init.config };"""
assert old in src, "anchor missing"
src = src.replace(old, new, 1)
p.write_text(src, encoding="utf-8")
print("fixed")
