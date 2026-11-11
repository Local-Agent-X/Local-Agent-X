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
    expect(stored).toContain("repeating myself");
  });

  it("finalize trims surrounding whitespace", () => {
    const h = new VoiceTurnHygiene();
    h.delta("  spoken reply  ");
    expect(h.finalize()).toBe("spoken reply");
  });
});

describe("VoiceTurnHygiene.lookupStarted — no silent lookups", () => {
  it("speaks a line when a lookup starts before the model said anything, and keeps it in the transcript", () => {
    const h = new VoiceTurnHygiene();
    const line = h.lookupStarted("memory_search");
    expect(line).toMatch(/\S/);
    expect(h.delta("Your interview is Tuesday.")).toBe("Your interview is Tuesday.");
    expect(h.finalize()).toBe(`${line}Your interview is Tuesday.`);
  });

  it("stays quiet when the model already spoke before the lookup", () => {
    const h = new VoiceTurnHygiene();
    h.delta("Sure, let me check. ");
    expect(h.lookupStarted("web_search")).toBeNull();
  });

  // "Let me check." answered "we already had this talk", and "Still looking."
  // ran straight into "I don't have his email" (2026-11-11): a line names
  // what is being looked at.
  it("says what each lookup looks at", () => {
    expect(new VoiceTurnHygiene().lookupStarted("search_past_sessions")).toBe("Looking back through our chats. ");
    expect(new VoiceTurnHygiene().lookupStarted("memory_search")).toBe("Checking my notes. ");
    expect(new VoiceTurnHygiene().lookupStarted("email_search")).toBe("Checking your email. ");
    expect(new VoiceTurnHygiene().lookupStarted("web_search")).toBe("Searching the web. ");
  });

  it("names a second silent lookup only when it looks somewhere new, then stops at two", () => {
    const h = new VoiceTurnHygiene();
    expect(h.lookupStarted("memory_search")).toBe("Checking my notes. ");
    expect(h.lookupStarted("search_past_sessions")).toBe("Now looking back through our chats. ");
    expect(h.lookupStarted("search_past_sessions")).toBeNull();
    expect(h.lookupStarted("email_search")).toBeNull();
  });

  it("says nothing more for another lookup of the same kind", () => {
    const h = new VoiceTurnHygiene();
    expect(h.lookupStarted("search_past_sessions")).not.toBeNull();
    expect(h.lookupStarted("search_past_sessions")).toBeNull();
  });

  it("fills the next silent gap after the model spoke before an earlier lookup", () => {
    const h = new VoiceTurnHygiene();
    h.delta("Okay — ");
    expect(h.lookupStarted("web_search")).toBeNull();
    expect(h.lookupStarted("memory_search")).not.toBeNull();
  });

  it("never fills for the sphere or an action (a fact save, a hand-off, scheduling)", () => {
    const h = new VoiceTurnHygiene();
    for (const t of ["voice_visual", "remember", "op_submit_async", "mission_schedule_create"]) expect(h.lookupStarted(t)).toBeNull();
  });
});
