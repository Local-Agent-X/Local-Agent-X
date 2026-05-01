import pathlib
p = pathlib.Path('src/voice/tier4/kokoro-engine.ts')
src = p.read_text(encoding='utf-8')
old = """export interface KokoroEngine {
  synth(text: string, opts?: { voice?: string; speed?: number }): Promise<RawAudio>;
  close(): Promise<void>;
  readonly sampleRate: number;
  readonly voice: string;
  readonly modelId: string;
}"""
new = """export interface KokoroEngine {
  synth(text: string, opts?: { voice?: string; speed?: number }): Promise<RawAudio>;
  close(): Promise<void>;
  readonly sampleRate: number;
  readonly voice: string;
  readonly modelId: string;
  readonly runtime: { device: Tier4Device; dtype: Tier4Dtype; fellBack: boolean };
}"""
assert old in src, 'anchor missing'
src = src.replace(old, new, 1)
p.write_text(src, encoding='utf-8')
print('step3 ok')
