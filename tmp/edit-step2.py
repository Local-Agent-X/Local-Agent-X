import pathlib
p = pathlib.Path('src/voice/tier4/kokoro-engine.ts')
src = p.read_text(encoding='utf-8')
old = 'import { configureHFCache, tier4ModelStatus } from "./voice-clone-loader.js";\nimport type { Tier4Config, Tier4Device, Tier4Dtype } from "./types.js";\nimport { TIER4_DEFAULTS, TIER4_SAMPLE_RATE } from "./types.js";\n\ntype RawAudio'
extra = """

const VALID_DEVICES: ReadonlySet<Tier4Device> = new Set<Tier4Device>([
  "cpu", "wasm", "webgpu", "dml", "cuda", "auto",
]);
const VALID_DTYPES: ReadonlySet<Tier4Dtype> = new Set<Tier4Dtype>([
  "fp32", "fp16", "q8", "q4", "q4f16",
]);

function envDevice(): Tier4Device | undefined {
  const v = process.env.LAX_VOICE_TIER4_DEVICE?.toLowerCase() as Tier4Device | undefined;
  return v && VALID_DEVICES.has(v) ? v : undefined;
}

function envDtype(): Tier4Dtype | undefined {
  const v = process.env.LAX_VOICE_TIER4_DTYPE?.toLowerCase() as Tier4Dtype | undefined;
  return v && VALID_DTYPES.has(v) ? v : undefined;
}

type RawAudio"""
new = 'import { configureHFCache, tier4ModelStatus } from "./voice-clone-loader.js";\nimport type { Tier4Config, Tier4Device, Tier4Dtype } from "./types.js";\nimport { TIER4_DEFAULTS, TIER4_SAMPLE_RATE } from "./types.js";' + extra
assert old in src, 'anchor1 missing'
src = src.replace(old, new, 1)
p.write_text(src, encoding='utf-8')
print('step2 ok, len', len(src))
