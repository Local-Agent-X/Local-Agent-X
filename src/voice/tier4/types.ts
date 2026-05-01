// Tier 4 voice types — shared across the kokoro / chatterbox modules.
//
// Tier 4 = native Node TTS (no Python sidecar). Default engine is Kokoro-82M
// quantized (q4f16) running through @huggingface/transformers + onnxruntime-node.
// On Windows that resolves to the DirectML EP, on Linux/macOS to CPU.

export type Tier4Dtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";
export type Tier4Device = "cpu" | "wasm" | "webgpu" | "dml" | "cuda" | "auto";

export interface Tier4Config {
  modelId?: string;
  dtype?: Tier4Dtype;
  device?: Tier4Device;
  voice?: string;
  speed?: number;
  cacheDir?: string;
}

export const TIER4_DEFAULTS: Required<Omit<Tier4Config, "cacheDir">> = {
  modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
  dtype: "q4f16",
  device: process.platform === "win32" ? "dml" : "cpu",
  voice: "am_michael",
  speed: 1.05,
};

export const TIER4_SAMPLE_RATE = 24000;

export interface Tier4Callbacks {
  onAudio?: (pcm: Int16Array, sampleRate: number) => void;
  onSentenceEnd?: (text: string) => void;
  onIdle?: () => void;
  onError?: (err: Error) => void;
}

export interface Tier4StreamingTTS {
  speak(text: string): void;
  readonly sampleRate: number;
  readonly voice: string;
  cancel(): void;
  close(): void;
}

export interface Tier4DiagSnapshot {
  modelId: string;
  dtype: Tier4Dtype;
  device: Tier4Device;
  loadMs: number;
  firstAudioMs: number | null;
  totalSentences: number;
  cancelledSentences: number;
}
