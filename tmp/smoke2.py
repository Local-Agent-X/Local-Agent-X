import pathlib
p = pathlib.Path("scripts/test-tier4-smoke.mjs")
src = p.read_text(encoding="utf-8")
old = '    console.log(`[tier4 smoke] realtime factor: ${rtf.toFixed(3)}x (lower = faster)`);'
extra = '\n    const diag = snapshotTier4Diag(tts);\n    if (diag) {\n      console.log(`[tier4 smoke] runtime: device=${diag.device} dtype=${diag.dtype} fellBack=${diag.fellBack}`);\n    }'
new = old + extra
assert old in src
src = src.replace(old, new, 1)
p.write_text(src, encoding="utf-8")
print("smoke step2 ok")
