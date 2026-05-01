import pathlib
p = pathlib.Path("scripts/test-tier4-smoke.mjs")
src = p.read_text(encoding="utf-8")
PIPE = chr(124)+chr(124)
a = '//   npx tsx scripts/test-tier4-smoke.mjs --device cpu       (force CPU EP)'
b = a + '\n//   npx tsx scripts/test-tier4-smoke.mjs --device dml --dtype fp16  (GPU opt-in)'
src = src.replace(a, b, 1)
src = src.replace('createTier4, tier4Readiness ', 'createTier4, tier4Readiness, snapshotTier4Diag ', 1)
old3 = 'const device = arg("--device") ' + PIPE + ' undefined;'
new3 = old3 + '\nconst dtype = arg("--dtype") ' + PIPE + ' undefined;'
src = src.replace(old3, new3, 1)
src = src.replace('createTier4({ voice, device }', 'createTier4({ voice, device, dtype }', 1)
p.write_text(src, encoding="utf-8")
print("smoke step1 ok len=", len(src))
