import pathlib
p = pathlib.Path('src/voice/tier4/kokoro-engine.ts')
src = p.read_text(encoding='utf-8')
old = "// to cancel, and within the latency budget for short clauses on the 3060."
new = old + "\n//\n// GPU opt-in: defaults q8+cpu. Users opt into DirectML/CUDA/WebGPU via\n// LAX_VOICE_TIER4_DEVICE plus optional LAX_VOICE_TIER4_DTYPE. If the GPU EP\n// fails to bind we fall back to cpu+q8 so the user still gets audio."
assert old in src
src = src.replace(old, new, 1)
p.write_text(src, encoding='utf-8')
print('step1 ok')
