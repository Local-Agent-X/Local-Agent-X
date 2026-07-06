import { describe, expect, it } from "vitest";
import {
  checkUnsupportedOperationalClaim,
  findDefinitiveOperationalClaimSentence,
  hasFreshOperationalEvidence,
  looksLikeDefinitiveOperationalClaim,
  runtimeCausalityEvidence,
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
    expect(runtimeCausalityEvidence(tools)).toEqual(["diagnostic-read"]);
    expect(checkUnsupportedOperationalClaim("The server blocked it because the policy rejected the call.", tools))
      .toBeNull();
  });

  it("maps diagnostic tool families into canonical diagnostic-read evidence", () => {
    for (const tool of ["read", "grep_logs", "query_state", "inspect_policy", "status", "bash", "browser", "http_request"]) {
      expect(runtimeCausalityEvidence(new Set([tool])), tool).toEqual(["diagnostic-read"]);
    }
  });

  it("does not map memory or tool discovery to diagnostic evidence", () => {
    for (const tool of ["memory_search", "memory_recall", "tool_search", "search_past_sessions"]) {
      expect(runtimeCausalityEvidence(new Set([tool])), tool).toEqual([]);
    }
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

  it("returns the exact flagged sentence for the downstream LLM confirm", () => {
    const text =
      "Let me walk through it. The firewall blocked the request. Everything else looked normal.";
    expect(findDefinitiveOperationalClaimSentence(text)).toBe("The firewall blocked the request.");
    expect(findDefinitiveOperationalClaimSentence("No operational content here.")).toBeNull();
  });

  it("prefilter is knowingly negation-blind — the middleware's LLM confirm owns that verdict", () => {
    // Locked contract: the regex tier still flags a negated sentence; the
    // suppression of this false positive happens at the confirm gate, not here.
    const text = "The firewall did NOT block the request.";
    expect(looksLikeDefinitiveOperationalClaim(text)).toBe(true);
    expect(findDefinitiveOperationalClaimSentence(text)).toBe(text);
  });
});
