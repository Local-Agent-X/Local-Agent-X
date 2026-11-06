// The phone's voice picker offers what this desktop's engine can say, and a pick is
// saved where that engine reads it: the sidecar's English Kokoro voices and the user's
// clones (ttsVoice), the in-process engine's English Kokoro voices (voiceTier4Voice).
import { describe, it, expect, vi, beforeEach } from "vitest";

const saved: Record<string, unknown> = {};
let engine: { engine: string; ttsVoice?: string; tier4Voice?: string; tier4Provider?: string } = { engine: "python" };
vi.mock("./voice-session/settings.js", () => ({ resolveVoiceSettings: () => engine }));
vi.mock("../settings.js", () => ({ setSetting: (k: string, v: unknown) => { saved[k] = v; } }));

const { listCallVoices, rememberCallVoice } = await import("./call-voices.js");
const clones = async () => [{ id: "vx:optimus", name: "Optimus", group: "Your voices" }];

beforeEach(() => { for (const k of Object.keys(saved)) delete saved[k]; });

describe("the voices a call offers", () => {
  it("on the sidecar: the user's clones first, then English Kokoro voices, and the voice now", async () => {
    engine = { engine: "python", ttsVoice: "vx:optimus" };
    const { voices, current } = await listCallVoices(clones);
    expect(voices[0]).toEqual({ id: "vx:optimus", name: "Optimus", group: "Your voices" });
    expect(voices).toContainEqual({ id: "am_onyx", name: "Onyx", group: "American" });
    expect(voices).toContainEqual({ id: "bf_emma", name: "Emma", group: "British" });
    expect(voices.some((v) => v.id === "jf_alpha")).toBe(false);
    expect(current).toBe("vx:optimus");
  });

  it("in-process: Kokoro only; another engine offers none", async () => {
    engine = { engine: "tier4", tier4Voice: "af_heart" };
    const offer = await listCallVoices(clones);
    expect(offer.voices.some((v) => v.id.startsWith("vx:"))).toBe(false);
    expect(offer.current).toBe("af_heart");
    engine = { engine: "cpu_fallback" };
    expect((await listCallVoices(clones)).voices).toEqual([]);
  });
});

describe("remembering the pick", () => {
  it("saves it in the engine's own setting, and refuses a voice the engine cannot speak", async () => {
    engine = { engine: "python" };
    await rememberCallVoice("vx:optimus");
    expect(saved).toEqual({ ttsVoice: "vx:optimus" });
    engine = { engine: "tier4" };
    await rememberCallVoice("vx:optimus");
    await rememberCallVoice("am_onyx");
    expect(saved).toEqual({ ttsVoice: "vx:optimus", voiceTier4Voice: "am_onyx" });
  });
});
