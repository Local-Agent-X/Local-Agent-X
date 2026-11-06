import { describe, it, expect } from "vitest";
import { VOICE_FAST_TOOLS, buildVoiceTail } from "./voice-prompt.js";

describe("voice tool belt", () => {
  it("can look up and save memory, so a spoken turn never says it doesn't have what was discussed", () => {
    // Without these a voice call told the user it had no job description that
    // an October chat covered in detail, and had no way to keep a new date.
    for (const t of ["memory_search", "search_past_sessions", "remember", "memory_set_user_field"]) {
      expect(VOICE_FAST_TOOLS).toContain(t);
    }
  });

  it("tells the spoken model to check memory before saying it doesn't know", () => {
    const tail = buildVoiceTail(false);
    expect(tail).toContain("memory_search");
    expect(tail).toContain("search_past_sessions");
    expect(tail).toContain("remember");
    // A spoken "stop calling me X" fixes the name the profile gives every prompt.
    expect(tail).toContain("memory_set_user_field");
  });
});
