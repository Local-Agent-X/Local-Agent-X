import pathlib
p = pathlib.Path("src/voice/tier4/types.ts")
src = p.read_text(encoding="utf-8")
old = """export interface Tier4DiagSnapshot {
  modelId: string;
  dtype: Tier4Dtype;
  device: Tier4Device;
  loadMs: number;
  firstAudioMs: number | null;
  totalSentences: number;
  cancelledSentences: number;
}"""
new = """export interface Tier4DiagSnapshot {
  modelId: string;
  dtype: Tier4Dtype;
  device: Tier4Device;
  loadMs: number;
  firstAudioMs: number | null;
  totalSentences: number;
  cancelledSentences: number;
  /** True if the engine was asked for a GPU EP (DML/CUDA/WebGPU) that failed
   *  to bind and got transparently fallen back to cpu+q8. */
  fellBack: boolean;
}"""
assert old in src, "anchor missing"
src = src.replace(old, new, 1)
p.write_text(src, encoding="utf-8")
print("types updated")
