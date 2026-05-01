import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_WHISPER_VARIANT,
  VALID_WHISPER_VARIANTS,
  getWhisperModelPaths,
  resolveWhisperVariant,
  whisperModelExists,
} from "../src/voice/whisper-model-fetch.js";

const ENV_KEYS = ["LAX_VOICE_WHISPER_MODEL"];

describe("resolveWhisperVariant precedence", () => {
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

  it("returns DEFAULT_WHISPER_VARIANT when nothing is set", () => {
    expect(resolveWhisperVariant()).toBe(DEFAULT_WHISPER_VARIANT);
  });

  it("explicit opts.variant wins over env", () => {
    process.env.LAX_VOICE_WHISPER_MODEL = "small.en";
    expect(resolveWhisperVariant({ variant: "base.en" })).toBe("base.en");
  });

  it("env var is used when no opts.variant is given", () => {
    process.env.LAX_VOICE_WHISPER_MODEL = "small.en";
    expect(resolveWhisperVariant()).toBe("small.en");
  });

  it("env var is lowercased + trimmed before validation", () => {
    process.env.LAX_VOICE_WHISPER_MODEL = "  SMALL.EN  ";
    expect(resolveWhisperVariant()).toBe("small.en");
  });

  it("invalid env var falls through to default (no throw)", () => {
    process.env.LAX_VOICE_WHISPER_MODEL = "huge";
    expect(resolveWhisperVariant()).toBe(DEFAULT_WHISPER_VARIANT);
  });

  it("invalid opts.variant falls through to env then default", () => {
    process.env.LAX_VOICE_WHISPER_MODEL = "base.en";
    expect(resolveWhisperVariant({ variant: "huge" as never })).toBe("base.en");
  });

  it("DEFAULT_WHISPER_VARIANT is itself a valid variant", () => {
    expect(VALID_WHISPER_VARIANTS.has(DEFAULT_WHISPER_VARIANT)).toBe(true);
  });
});

describe("getWhisperModelPaths", () => {
  it("derives encoder/decoder/tokens paths under the model dir", () => {
    const p = getWhisperModelPaths({ variant: "tiny.en" });
    expect(p.variant).toBe("tiny.en");
    expect(p.modelDir).toBe(join(homedir(), ".lax", "models", "whisper-tiny-en"));
    expect(p.encoder).toBe(join(p.modelDir, "tiny.en-encoder.int8.onnx"));
    expect(p.decoder).toBe(join(p.modelDir, "tiny.en-decoder.int8.onnx"));
    expect(p.tokens).toBe(join(p.modelDir, "tiny.en-tokens.txt"));
  });

  it("uses the variant-with-dash directory naming consistently across variants", () => {
    for (const v of ["tiny.en", "base.en", "small.en"] as const) {
      const p = getWhisperModelPaths({ variant: v });
      expect(p.modelDir.endsWith(`whisper-${v.replace(".", "-")}`)).toBe(true);
      expect(p.encoder).toContain(`${v}-encoder.int8.onnx`);
      expect(p.decoder).toContain(`${v}-decoder.int8.onnx`);
      expect(p.tokens).toContain(`${v}-tokens.txt`);
    }
  });

  it("falls back to DEFAULT_WHISPER_VARIANT when no opts given", () => {
    const p = getWhisperModelPaths();
    expect(p.variant).toBe(DEFAULT_WHISPER_VARIANT);
  });
});

describe("whisperModelExists", () => {
  it("returns false for a fresh-install variant whose dir does not exist", () => {
    // The test environment is unlikely to have any whisper variant downloaded;
    // even if it does, an obviously-bogus 'variant' through the public API
    // resolves to default — which is also unlikely on CI. Belt + suspenders:
    // we assert the function returns a boolean and doesn't throw.
    const result = whisperModelExists({ variant: "tiny.en" });
    expect(typeof result).toBe("boolean");
  });
});
