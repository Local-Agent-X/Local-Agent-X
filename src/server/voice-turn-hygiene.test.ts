import { describe, it, expect } from "vitest";
import { VoiceTurnHygiene, VOICE_GUARD_STOP_NOTICE } from "./voice-turn-hygiene.js";

describe("VoiceTurnHygiene", () => {
  it("speaks clean deltas verbatim and accumulates them", () => {
    const h = new VoiceTurnHygiene();
    expect(h.delta("Hey Peter, ")).toBe("Hey Peter, ");
    expect(h.delta("how are you?")).toBe("how are you?");
    expect(h.finalize()).toBe("Hey Peter, how are you?");
  });

  it("strips leaked chat-template tokens from a spoken delta", () => {
    const h = new VoiceTurnHygiene();
    // A leaked end-of-turn token must not reach TTS.
    const spoken = h.delta("All done<|im_end|>");
    expect(spoken).toBe("All done");
  });

  it("drops a junk-only delta rather than feeding an empty string to TTS", () => {
    const h = new VoiceTurnHygiene();
    // A delta that is nothing but a leaked token yields null → caller skips.
    expect(h.delta("<|im_end|>")).toBeNull();
    // But it is NOT counted toward spoken text; a following real delta speaks.
    expect(h.delta("Hello")).toBe("Hello");
  });

  it("scrubs the transcript of hallucinated tool markup and self-repetition", () => {
    const h = new VoiceTurnHygiene();
    // The verbatim reply from the incident that motivated this campaign — a
    // stray HTML closer, the whole reply repeated (≥80 chars, so it collapses),
    // and a fabricated tool-call block, all fed as separate deltas.
    const reply =
      "Hey Peter, yep, still here. Ready when you are—what's top of mind today? Are we tackling a project, or just browsing?";
    h.delta(reply);
    h.delta("</blockquote>\n");
    h.delta(reply);
    h.delta("\n<execute_tool>\nNone\n</execute_tool>");
    const stored = h.finalize();
    expect(stored).toBe(reply);
    expect(stored).not.toContain("execute_tool");
    expect(stored).not.toContain("blockquote");
  });

  it("preserves the raw text for the full pass even when the streaming strip missed a split token", () => {
    const h = new VoiceTurnHygiene();
    // A control token split across two deltas passes the per-delta strip live,
    // but the whole-document finalize pass still removes the reassembled token.
    h.delta("Done<|im_");
    h.delta("end|>");
    expect(h.finalize()).toBe("Done");
  });

  it("voices a guard-stop notice and records it in the transcript", () => {
    const h = new VoiceTurnHygiene();
    h.delta("Here is the ");
    const notice = h.guardStopped();
    expect(notice).toBe(VOICE_GUARD_STOP_NOTICE);
    const stored = h.finalize();
    expect(stored).toContain("Here is the");
    expect(stored).toContain("glitched");
  });

  it("finalize trims surrounding whitespace", () => {
    const h = new VoiceTurnHygiene();
    h.delta("  spoken reply  ");
    expect(h.finalize()).toBe("spoken reply");
  });
});
