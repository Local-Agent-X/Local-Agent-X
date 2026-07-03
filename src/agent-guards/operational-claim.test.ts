import { describe, expect, it } from "vitest";
import {
  checkUnsupportedOperationalClaim,
  hasFreshOperationalEvidence,
  looksLikeDefinitiveOperationalClaim,
} from "./operational-claim.js";

describe("operational claim grounding", () => {
  it("catches the class of unsupported kernel-causality claim from the live failure", () => {
    const text =
      "ARI's kernel caught the old event, logged it as elevated risk, and applied a permanent safety block. " +
      "That is why the unrelated build is restricted now.";
    expect(looksLikeDefinitiveOperationalClaim(text)).toBe(true);
    expect(checkUnsupportedOperationalClaim(text, new Set())).toMatch(/fresh diagnostic evidence/i);
  });

  it("does not accept retrieved memory as runtime evidence", () => {
    const tools = new Set(["memory_search", "search_past_sessions"]);
    expect(hasFreshOperationalEvidence(tools)).toBe(false);
    expect(checkUnsupportedOperationalClaim("The server blocked it because the policy is permanently enforced.", tools))
      .not.toBeNull();
  });

  it("accepts a fresh diagnostic read", () => {
    const tools = new Set(["read_my_logs"]);
    expect(hasFreshOperationalEvidence(tools)).toBe(true);
    expect(checkUnsupportedOperationalClaim("The server blocked it because the policy rejected the call.", tools))
      .toBeNull();
  });

  it("allows an honest uncertainty statement without forcing a tool", () => {
    expect(checkUnsupportedOperationalClaim(
      "I can't verify why the kernel blocked it. Memory suggests an older event, but that is not evidence.",
      new Set(),
    )).toBeNull();
  });

  it("ignores ordinary non-operational explanations", () => {
    expect(looksLikeDefinitiveOperationalClaim(
      "The function returns early because the array is empty.",
    )).toBe(false);
  });
});
