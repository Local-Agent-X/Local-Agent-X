// Dictation (the desktop mic button), bridge voice notes and the file
// transcription tool share one transcriber. It used to load the default
// tiny.en whatever voice chat used, so a user on the Local tier got Parakeet
// in voice chat and the weak model everywhere else. It now loads the model
// settings.voiceWhisperModel names, and rebuilds when that changes.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  whisperModel: undefined as string | undefined,
  downloaded: [] as string[],
  built: [] as string[],
  closed: 0,
}));

vi.mock("../voice/voice-session/settings.js", () => ({
  resolveVoiceSettings: () => ({ engine: "tier4", whisperModel: state.whisperModel }),
}));
vi.mock("../voice/whisper-model-fetch.js", async (orig) => ({
  ...(await orig<typeof import("../voice/whisper-model-fetch.js")>()),
  ensureWhisperModelDownloaded: vi.fn(async (_p: unknown, opts?: { variant?: string }) => {
    state.downloaded.push(String(opts?.variant));
    return { variant: opts?.variant, kind: "whisper", encoder: "", decoder: "", tokens: "", modelDir: "" };
  }),
}));
vi.mock("../voice/stt-providers/index.js", async (orig) => ({
  ...(await orig<typeof import("../voice/stt-providers/index.js")>()),
  resolveSttProviderName: () => undefined,
  createSttProvider: vi.fn((_name: string, opts: { local?: { paths: { variant: string } } }) => {
    state.built.push(opts.local?.paths.variant ?? "cloud");
    return { transcribe: async () => "", close: () => { state.closed++; }, runtime: { provider: "cpu", fellBack: false } };
  }),
}));

const { getSharedTranscriber } = await import("./stt-helper.js");

beforeEach(() => {
  state.downloaded = [];
  state.built = [];
  state.closed = 0;
});

describe("the shared transcriber follows the voice-chat speech model", () => {
  it("loads Parakeet when voice chat uses it", async () => {
    state.whisperModel = "parakeet-v3";
    await getSharedTranscriber();
    expect(state.downloaded).toEqual(["parakeet-v3"]);
    expect(state.built).toEqual(["parakeet-v3"]);
  });

  it("reuses the loaded model while the setting is unchanged", async () => {
    state.whisperModel = "parakeet-v3";
    const a = await getSharedTranscriber();
    const b = await getSharedTranscriber();
    expect(a).toBe(b);
    expect(state.built).toEqual([]);
  });

  it("swaps models when the setting changes, closing the old one", async () => {
    state.whisperModel = "tiny.en";
    await getSharedTranscriber();
    expect(state.built).toEqual(["tiny.en"]);
    expect(state.closed).toBe(1);
  });

  it("falls back to the default when nothing is saved", async () => {
    // An empty data dir: with no Parakeet on disk the default is tiny.en.
    const saved = process.env.LAX_DATA_DIR;
    const dir = mkdtempSync(join(tmpdir(), "lax-stt-helper-"));
    process.env.LAX_DATA_DIR = dir;
    try {
      state.whisperModel = undefined;
      await getSharedTranscriber();
      expect(state.built).toEqual([]); // default is tiny.en, already loaded
    } finally {
      if (saved === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
