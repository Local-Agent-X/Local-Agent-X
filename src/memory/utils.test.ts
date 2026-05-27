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
import { parseFactLine } from "./utils.js";

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
    const r = parseFactLine("W @user owns NutriShop McKinney");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("world");
    expect(r!.confidence).toBe(1.0);
    expect(r!.entities).toEqual(["user"]);
    expect(r!.content).toBe("owns NutriShop McKinney");
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
