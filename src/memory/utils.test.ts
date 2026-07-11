/**
 * Regression tests for parseFactLine prefix-letter mapping.
 *
 * Background: the dream-extraction prompt in memory-extract.ts and the parser
 * here used to disagree about what the letter prefixes meant — the prompt
 * told the LLM `B = behavior` and `S = schedule`, but the parser mapped
 * B → experience and S → observation. So every dream fact was silently
 * mis-bucketed (behavior patterns rendered as "still fresh" life events,
 * schedules landed as misc notes). Fixed by collapsing both writer and
 * parser onto a single schema-aligned mapping: W/O/E/S where each letter
 * directly names a FactKind.
 */
import { describe, it, expect } from "vitest";
import { parseFactLine, displayContent, redactCredentials } from "./utils.js";

describe("parseFactLine — schema-aligned prefix letters", () => {
  it("E maps to experience and parses confidence + entity", () => {
    const r = parseFactLine("E(c=0.9) @rex Rex passed away");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("experience");
    expect(r!.confidence).toBeCloseTo(0.9);
    expect(r!.entities).toEqual(["rex"]);
    expect(r!.content).toBe("Rex passed away");
  });

  it("S maps to observation and parses confidence", () => {
    const r = parseFactLine("S(c=0.8) @user writes commits in past tense");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("observation");
    expect(r!.confidence).toBeCloseTo(0.8);
    expect(r!.entities).toEqual(["user"]);
    expect(r!.content).toBe("writes commits in past tense");
  });

  it("W with no (c=...) defaults to confidence 1.0", () => {
    const r = parseFactLine("W @user owns Initech Dallas");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("world");
    expect(r!.confidence).toBe(1.0);
    expect(r!.entities).toEqual(["user"]);
    expect(r!.content).toBe("owns Initech Dallas");
  });

  it("O maps to opinion", () => {
    const r = parseFactLine("O @user prefers light mode");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("opinion");
    expect(r!.confidence).toBe(1.0);
    expect(r!.content).toBe("prefers light mode");
  });

  // Legacy B (behavior) prefix is gone. Returning null is the safer choice:
  // silently demoting a malformed prefix to observation (the prior default
  // fall-through behavior) is what caused the original mis-bucketing bug.
  // Drop the line and let the caller log/ignore instead of smuggling a
  // garbage "B(c=0.8) ..." string into the content of an observation fact.
  it("B (legacy behavior prefix) returns null — no silent fallback", () => {
    expect(parseFactLine("B(c=0.8) writes commits in past tense")).toBeNull();
    expect(parseFactLine("B @user some pattern")).toBeNull();
  });

  // Prefix-less lines (no leading capital-letter token) still parse as
  // observation — that's the documented fallback for plain `- @user X` bullets.
  it("prefix-less line defaults to observation", () => {
    const r = parseFactLine("@user just some plain note");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("observation");
    expect(r!.confidence).toBe(1.0);
    expect(r!.entities).toEqual(["user"]);
  });
});

describe("displayContent — re-attaches stripped entities for display", () => {
  it("no entities → content unchanged", () => {
    expect(displayContent({ content: "user prefers oat milk", entities: [] }))
      .toBe("user prefers oat milk");
  });

  it("single entity → ` (@name)` appended", () => {
    expect(displayContent({ content: "is the user's wife", entities: ["dana"] }))
      .toBe("is the user's wife (@dana)");
  });

  it("multiple entities → comma-separated `(@a, @b)`", () => {
    expect(displayContent({ content: "adopted puppies", entities: ["fido", "rex"] }))
      .toBe("adopted puppies (@fido, @rex)");
  });
});

// Regression: memory's at-rest redaction used to be a FORK of the security
// credential catalog and had silently drifted — provider-key shapes added to
// security/credential-patterns.ts (Anthropic sk-ant-, xAI xai-, Google AIza,
// entropy-aware masking) never reached the memory index. redactCredentials
// now routes through the canonical catalog; these cases FAIL on the old
// forked list. Cross-seam contract: memory ⇄ security share ONE definition
// of "what counts as a credential."
describe("redactCredentials — canonical catalog seam (memory ⇄ security)", () => {
  it("catches canonical-catalog shapes the old memory fork missed", () => {
    // Anthropic key: fork's generic rule required [a-zA-Z0-9]{20,} with NO
    // inner dashes after the prefix, so sk-ant-... slipped through whole.
    const anthropic = redactCredentials(
      "note: my key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv-1234567890abcdef"
    );
    expect(anthropic).not.toContain("api03-AbCdEfGhIjKlMnOpQrStUv");

    // Google API key: no prefix the fork knew about at all.
    const google = redactCredentials("google key AIzaSyA1234567890abcdefghijklmnopqrstuv sent");
    expect(google).not.toContain("SyA1234567890abcdefghijklmnopqrstuv");
  });

  it("still redacts the shapes the fork did cover (no regression on merge)", () => {
    const gh = redactCredentials("token ghp_" + "a".repeat(40) + " in log");
    expect(gh).not.toContain("ghp_" + "a".repeat(40));

    const dbUrl = redactCredentials("db at postgres://admin:hunter2@db.internal:5432/prod");
    expect(dbUrl).not.toContain("hunter2");
  });

  it("keeps the memory-local PII rule: credit card numbers", () => {
    const cc = redactCredentials("card 4111 1111 1111 1111 on file");
    expect(cc).toContain("[REDACTED]");
    expect(cc).not.toContain("4111 1111 1111 1111");
  });

  it("canonical catalog now covers the fork-only credential shapes (ghu_/ghr_/Basic)", () => {
    const ghu = redactCredentials("user token ghu_" + "b".repeat(40));
    expect(ghu).not.toContain("ghu_" + "b".repeat(40));

    const basic = redactCredentials("Authorization: Basic dXNlcjpodW50ZXIyLXNlY3JldC1wdw==");
    expect(basic).not.toContain("dXNlcjpodW50ZXIyLXNlY3JldC1wdw==");
  });
});
