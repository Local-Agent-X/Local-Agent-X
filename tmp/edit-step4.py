import pathlib
p = pathlib.Path('src/voice/tier4/kokoro-engine.ts')
src = p.read_text(encoding='utf-8')
old = """export async function createKokoroEngine(init: KokoroEngineInit): Promise<KokoroEngine> {
  const cfg = { ...TIER4_DEFAULTS, ...init.config };
  configureHFCache();

  const status = tier4ModelStatus(cfg.modelId);
  if (!status.cached && process.env.LAX_VOICE_DEBUG) {
    console.log(`[tier4/kokoro] cold start - first run will download to ${status.cacheDir}`);
  }

  const t0 = Date.now();
  const mod = (await import("kokoro-js")) as unknown as { KokoroTTS: KokoroTTSCtor };
  const tts = await mod.KokoroTTS.from_pretrained(cfg.modelId, {
    dtype: cfg.dtype,
    device: cfg.device,
  });
  const loadMs = Date.now() - t0;
  init.onLoad?.(loadMs);

  let closed = false;

  return {
    async synth(text: string, opts?: { voice?: string; speed?: number }) {
      if (closed) throw new Error("kokoro engine closed");
      return tts.generate(text, {
        voice: opts?.voice ?? cfg.voice,
        speed: opts?.speed ?? cfg.speed,
      });
    },
    async close() { closed = true; },
    get sampleRate() { return TIER4_SAMPLE_RATE; },
    get voice() { return cfg.voice; },
    get modelId() { return cfg.modelId; },
  };
}"""
# em-dash version
old_em = old.replace("cold start -", "cold start —")
new_block = pathlib.Path('tmp/replacement.txt').read_text(encoding='utf-8').rstrip()
if old_em in src:
    src = src.replace(old_em, new_block, 1)
    print('replaced em-dash variant')
elif old in src:
    src = src.replace(old, new_block, 1)
    print('replaced ascii variant')
else:
    raise SystemExit('neither variant found; check anchor')
p.write_text(src, encoding='utf-8')
print('len now', len(src))
