import { describe, it, expect } from "vitest";
import { buildVoiceTail } from "./voice-prompt.js";

describe("voice mode prompt section", () => {
  it("says how to talk, and that a spoken turn can do what a typed one can", () => {
    const tail = buildVoiceTail(false);
    expect(tail).toContain("## Voice mode");
    expect(tail).toContain("same tools and rules");
    // Things worth seeing are shown as cards, not read aloud.
    expect(tail).toContain("show_card");
    // Approvals are asked out loud by the app, not by the model first.
    expect(tail).toContain("DECLINED");
    // The app names a silent lookup out loud; the reply carries on from it.
    expect(tail).toContain("the app tells the user what you're looking at");
  });

  it("restates no routing rule of the main prompt", () => {
    // Its own narrower routing ("check memory_search, then
    // search_past_sessions") was followed over the main prompt's: a spoken
    // "email Tyler" checked memory, stopped, and said it had no address that
    // a typed turn then found in the inbox (2026-11-11).
    const tail = buildVoiceTail(true);
    for (const tool of ["memory_search", "search_past_sessions", "mission_schedule", "browser", "screen_capture", "web_search", "tool_search"]) {
      expect(tail).not.toContain(tool);
    }
  });

  it("mentions the sphere only when visuals are on", () => {
    expect(buildVoiceTail(false)).not.toContain("voice_visual");
    expect(buildVoiceTail(true)).toContain("voice_visual");
  });
});
