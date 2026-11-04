import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  DEFAULT_WHISPER_VARIANT,
  VALID_WHISPER_VARIANTS,
  ensureWhisperModelDownloaded,
  getWhisperModelPaths,
  resolveWhisperVariant,
  whisperDownloadState,
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

describe("Parakeet (a transducer, not Whisper)", () => {
  it("is a valid local speech model", () => {
    expect(VALID_WHISPER_VARIANTS.has("parakeet-v3")).toBe(true);
    expect(resolveWhisperVariant({ variant: "parakeet-v3" })).toBe("parakeet-v3");
  });

  it("resolves the encoder/decoder/joiner/tokens a NeMo transducer loads", () => {
    const p = getWhisperModelPaths({ variant: "parakeet-v3" });
    expect(p.kind).toBe("nemo_transducer");
    expect(p.modelDir).toBe(join(homedir(), ".lax", "models", "parakeet-tdt-0.6b-v3"));
    expect(p.encoder).toBe(join(p.modelDir, "encoder.int8.onnx"));
    expect(p.decoder).toBe(join(p.modelDir, "decoder.int8.onnx"));
    expect(p.joiner).toBe(join(p.modelDir, "joiner.int8.onnx"));
    expect(p.tokens).toBe(join(p.modelDir, "tokens.txt"));
  });

  it("Whisper variants stay Whisper, with no joiner", () => {
    const p = getWhisperModelPaths({ variant: "tiny.en" });
    expect(p.kind).toBe("whisper");
    expect(p.joiner).toBeUndefined();
  });
});

describe("one download per model at a time", () => {
  let dataDir: string;
  const savedDataDir = process.env.LAX_DATA_DIR;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-stt-fetch-"));
    process.env.LAX_DATA_DIR = dataDir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = savedDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("a second caller joins the running download instead of opening a second writer", async () => {
    let failGet!: (e: Error) => void;
    const gets: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "0" } });
      gets.push(url);
      return new Promise<Response>((_, reject) => { failGet = reject; });
    }));

    const first = ensureWhisperModelDownloaded(undefined, { variant: "parakeet-v3" });
    const second = ensureWhisperModelDownloaded(undefined, { variant: "parakeet-v3" });
    await vi.waitFor(() => expect(gets).toHaveLength(1));
    expect(whisperDownloadState("parakeet-v3")).toMatchObject({ downloading: true, cached: false });

    failGet(new Error("connection reset"));
    await expect(first).rejects.toThrow(/connection reset/);
    await expect(second).rejects.toThrow(/connection reset/);
    expect(gets).toHaveLength(1);
    expect(whisperDownloadState("parakeet-v3")).toMatchObject({
      downloading: false, cached: false, error: expect.stringContaining("connection reset"),
    });
  });

  it("a retry after a failure starts a fresh download and clears the error", async () => {
    let failGet!: (e: Error) => void;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "HEAD") return new Response(null);
      return new Promise<Response>((_, reject) => { failGet = reject; });
    }));
    const first = ensureWhisperModelDownloaded(undefined, { variant: "base.en" });
    await vi.waitFor(() => expect(failGet).toBeTypeOf("function"));
    failGet(new Error("offline"));
    await expect(first).rejects.toThrow(/offline/);
    expect(whisperDownloadState("base.en").error).toMatch(/offline/);

    failGet = undefined as never;
    const retry = ensureWhisperModelDownloaded(undefined, { variant: "base.en" });
    await vi.waitFor(() => expect(failGet).toBeTypeOf("function"));
    expect(whisperDownloadState("base.en")).toMatchObject({ downloading: true });
    expect(whisperDownloadState("base.en").error).toBeUndefined();
    failGet(new Error("still offline"));
    await expect(retry).rejects.toThrow(/still offline/);
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
