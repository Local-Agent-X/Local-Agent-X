import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WHISPER_PROVIDER,
  VALID_WHISPER_PROVIDERS,
  buildConfig,
  resolveWhisperProvider,
} from "../src/voice/whisper-stream.js";
import { getWhisperModelPaths } from "../src/voice/whisper-model-fetch.js";

const ENV_KEYS = ["LAX_VOICE_WHISPER_DEVICE"];

describe("resolveWhisperProvider precedence", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns DEFAULT_WHISPER_PROVIDER when nothing is set", () => {
    expect(resolveWhisperProvider()).toBe(DEFAULT_WHISPER_PROVIDER);
  });

  it("explicit opts.provider wins over env", () => {
    process.env.LAX_VOICE_WHISPER_DEVICE = "dml";
    expect(resolveWhisperProvider({ provider: "cuda" })).toBe("cuda");
  });

  it("env var is used when no opts.provider is given", () => {
    process.env.LAX_VOICE_WHISPER_DEVICE = "dml";
    expect(resolveWhisperProvider()).toBe("dml");
  });

  it("env var is trimmed and lowercased before validation", () => {
    process.env.LAX_VOICE_WHISPER_DEVICE = "  DML  ";
    expect(resolveWhisperProvider()).toBe("dml");
  });

  it("invalid env var falls through to default (no throw)", () => {
    process.env.LAX_VOICE_WHISPER_DEVICE = "tpu";
    expect(resolveWhisperProvider()).toBe(DEFAULT_WHISPER_PROVIDER);
  });

  it("invalid opts.provider falls through to env then default", () => {
    process.env.LAX_VOICE_WHISPER_DEVICE = "cuda";
    expect(resolveWhisperProvider({ provider: "tpu" as never })).toBe("cuda");
    delete process.env.LAX_VOICE_WHISPER_DEVICE;
    expect(resolveWhisperProvider({ provider: "tpu" as never })).toBe(DEFAULT_WHISPER_PROVIDER);
  });

  it("empty / whitespace-only opts.provider falls through to env", () => {
    process.env.LAX_VOICE_WHISPER_DEVICE = "dml";
    expect(resolveWhisperProvider({ provider: "" as never })).toBe("dml");
    expect(resolveWhisperProvider({ provider: "   " as never })).toBe("dml");
  });

  it("DEFAULT_WHISPER_PROVIDER is itself a valid provider", () => {
    expect(VALID_WHISPER_PROVIDERS.has(DEFAULT_WHISPER_PROVIDER)).toBe(true);
  });

  it("VALID_WHISPER_PROVIDERS covers the documented options", () => {
    for (const p of ["cpu", "cuda", "dml", "coreml"] as const) {
      expect(VALID_WHISPER_PROVIDERS.has(p)).toBe(true);
    }
  });

  it("VALID_WHISPER_PROVIDERS rejects bogus values", () => {
    expect(VALID_WHISPER_PROVIDERS.has("tpu" as never)).toBe(false);
    expect(VALID_WHISPER_PROVIDERS.has("CPU" as never)).toBe(false);
    expect(VALID_WHISPER_PROVIDERS.has("" as never)).toBe(false);
  });

  it("non-string opts.provider is ignored without throwing", () => {
    expect(resolveWhisperProvider({ provider: 42 as never })).toBe(DEFAULT_WHISPER_PROVIDER);
    expect(resolveWhisperProvider({ provider: null as never })).toBe(DEFAULT_WHISPER_PROVIDER);
    expect(resolveWhisperProvider({ provider: undefined })).toBe(DEFAULT_WHISPER_PROVIDER);
  });
});

describe("buildConfig: the sherpa-onnx config each local model needs", () => {
  it("loads Parakeet as a NeMo transducer with its joiner", () => {
    const cfg = buildConfig(getWhisperModelPaths({ variant: "parakeet-v3" }), "cpu") as {
      modelConfig: Record<string, unknown> & { transducer?: Record<string, string> };
    };
    expect(cfg.modelConfig.modelType).toBe("nemo_transducer");
    expect(cfg.modelConfig.whisper).toBeUndefined();
    expect(cfg.modelConfig.transducer).toEqual({
      encoder: expect.stringMatching(/encoder\.int8\.onnx$/),
      decoder: expect.stringMatching(/decoder\.int8\.onnx$/),
      joiner: expect.stringMatching(/joiner\.int8\.onnx$/),
    });
    expect(cfg.modelConfig.numThreads).toBe(1);
  });

  it("keeps Whisper on its English transcribe config", () => {
    const cfg = buildConfig(getWhisperModelPaths({ variant: "tiny.en" }), "cpu") as {
      modelConfig: Record<string, unknown> & { whisper?: Record<string, unknown> };
    };
    expect(cfg.modelConfig.modelType).toBe("whisper");
    expect(cfg.modelConfig.transducer).toBeUndefined();
    expect(cfg.modelConfig.whisper).toMatchObject({ language: "en", task: "transcribe" });
  });
});
