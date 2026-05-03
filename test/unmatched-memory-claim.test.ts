import { describe, it, expect } from "vitest";
import { checkUnmatchedActionClaim } from "../src/agent-guards.js";

// Regression: model says "noted, I'll remember that" or "got it, saved" in
// reply but never calls memory_save / memory_update_profile. The guard
// caught "I saved X" before but not the memory-specific verbs (noted /
// remembered / recorded / logged / bookmarked). Same root cause as the
// older "I sent the email" without email_send hallucination — this test
// pins the memory-verb extension.

const NO_TOOLS = new Set<string>();
const SOME_OTHER_TOOL = new Set(["bash"]);
const MEMORY_TOOL_USED = new Set(["memory_save"]);
const PROFILE_TOOL_USED = new Set(["memory_update_profile"]);

describe("checkUnmatchedActionClaim — memory verbs", () => {
  it("flags 'I noted that' with no memory tool called", () => {
    const reply = "I noted that you prefer Meta Business Suite for analytics.";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS);
    expect(result).not.toBeNull();
    expect(result).toContain("memory_save");
  });

  it("flags 'I'll remember that' with no memory tool called", () => {
    const reply = "Got it. I'll remember that for next time.";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS);
    expect(result).not.toBeNull();
  });

  it("flags 'I've recorded that' with no memory tool called", () => {
    const reply = "I've recorded that preference in your profile.";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS);
    expect(result).not.toBeNull();
  });

  it("flags 'Noted!' at reply start with no memory tool called", () => {
    const reply = "Noted! That's a useful workflow rule.";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS);
    expect(result).not.toBeNull();
  });

  it("flags 'Remembered.' at reply start with no memory tool called", () => {
    const reply = "Remembered. Want me to do anything else?";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS);
    expect(result).not.toBeNull();
  });

  it("does NOT flag 'I noted that' when memory_save was called", () => {
    const reply = "I noted that you prefer Meta Business Suite for analytics.";
    const result = checkUnmatchedActionClaim(reply, MEMORY_TOOL_USED);
    expect(result).toBeNull();
  });

  it("does NOT flag 'I've recorded that' when memory_update_profile was called", () => {
    const reply = "I've recorded that in your profile.";
    const result = checkUnmatchedActionClaim(reply, PROFILE_TOOL_USED);
    expect(result).toBeNull();
  });

  it("flags 'I noted that' when only an unrelated tool was called", () => {
    const reply = "I noted that. Also ran the bash command.";
    const result = checkUnmatchedActionClaim(reply, SOME_OTHER_TOOL);
    expect(result).not.toBeNull();
  });

  it("flags the unified-claim case: 'I'll remember and save that'", () => {
    const reply = "I'll remember that and save it for next session.";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS);
    expect(result).not.toBeNull();
  });

  it("does NOT flag a non-claim reply", () => {
    const reply = "Sure, want me to look that up?";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS);
    expect(result).toBeNull();
  });

  it("does NOT flag past-tense factual reference (not a first-person claim)", () => {
    // "X was noted in the docs" is not "I noted X" — third-person, no claim.
    const reply = "The setting was previously documented but not enforced.";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS);
    expect(result).toBeNull();
  });

  it("flags 'I will note that' (future-tense claim variant)", () => {
    // "I will note" is still a commitment-as-action; without a memory tool
    // call, it's a hollow promise. CLAIM_FIRST_PERSON_RE includes 'will'/'\\'ll'.
    const reply = "I will note that for future reference.";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS);
    expect(result).not.toBeNull();
  });

  it("flags 'I'll bookmark that' with no memory tool called", () => {
    const reply = "I'll bookmark that for later.";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS);
    expect(result).not.toBeNull();
  });

  it("nudge text mentions which tools should have been called", () => {
    const reply = "I noted that you prefer X.";
    const result = checkUnmatchedActionClaim(reply, NO_TOOLS) || "";
    // The nudge tells the model the expected tool list so it can self-correct
    expect(result).toMatch(/memory_save|memory_update_profile/);
  });
});
