// A fresh install's voice is the Local tier, which hears with Parakeet. Its
// first voice session must not wait minutes on a ~670 MB download: it listens
// with the bundled tiny.en while Parakeet downloads in the background. A user
// who chose a model, or a tier that doesn't hear with Parakeet, starts no
// download.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedVoiceSettings } from "./settings.js";

const state = vi.hoisted(() => ({ calls: [] as (string | undefined)[], parakeetCached: false, localOnly: false }));

vi.mock("../whisper-model-fetch.js", async (orig) => ({
  ...(await orig<typeof import("../whisper-model-fetch.js")>()),
  ensureWhisperModelDownloaded: vi.fn(async (_p: unknown, opts?: { variant?: string }) => {
    state.calls.push(opts?.variant);
    return {};
  }),
  whisperDownloadState: () => ({ cached: state.parakeetCached, downloading: false, overallPct: 0 }),
}));
vi.mock("../../local-only-policy.js", async (orig) => ({
  ...(await orig<typeof import("../../local-only-policy.js")>()),
  isLocalOnlyMode: () => state.localOnly,
}));

const { ensureSessionSpeechModel } = await import("./model-init.js");

const session = (s: Partial<ResolvedVoiceSettings>) =>
  ensureSessionSpeechModel({ engine: "tier4", ...s }, () => {});

beforeEach(() => {
  state.calls = [];
  state.parakeetCached = false;
  state.localOnly = false;
  delete process.env.LAX_VOICE_WHISPER_MODEL;
});

describe("the speech model a voice session listens with", () => {
  it("a fresh install starts Parakeet in the background and listens with the default meanwhile", async () => {
    await session({});
    expect(state.calls).toEqual(["parakeet-v3", undefined]);
  });

  it("no second download once Parakeet is on disk", async () => {
    state.parakeetCached = true;
    await session({});
    expect(state.calls).toEqual([undefined]);
  });

  it("a saved model is the one the session waits for, with no background download", async () => {
    await session({ whisperModel: "tiny.en", tier4Provider: "kokoro" });
    expect(state.calls).toEqual(["tiny.en"]);
  });

  it("tiers that don't hear with Parakeet start no download", async () => {
    await session({ tier4Provider: "edge-tts" });
    await session({ sttProvider: "groq" });
    await session({ engine: "python" });
    expect(state.calls).toEqual([undefined, undefined, undefined]);
  });

  it("local-only mode downloads nothing new", async () => {
    state.localOnly = true;
    await session({});
    expect(state.calls).toEqual([undefined]);
  });
});
