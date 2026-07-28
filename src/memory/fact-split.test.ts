/**
 * The stamp/split round trip must be IDENTITY for a declared facts[] batch.
 *
 * The human approval card counts lines of the stamped join, and the per-call
 * fact cap counts derived facts. If join→split derived more facts than the
 * caller listed (it did: facts[] items used to be sentence-split), the card
 * understated what would be written and an early multi-sentence item could
 * push a later declared fact over the cap. A single `content` blob carries no
 * atomicity declaration, so it still splits — that path is where splitting
 * replaced the retry-hint round trip.
 */
import { describe, it, expect } from "vitest";
import { normalizeFactLine, splitDeclaredFacts, splitMultiFactBlob } from "./fact-split.js";
import { joinFactsForPromotion } from "./promotion-gate.js";

describe("facts[] join → split round trip", () => {
  it("returns the input array exactly, including sentence punctuation and a leading '- '", () => {
    const items = [
      "One. Two. Three. Four.",
      "- W(c=0.99) a line that merely LOOKS like a bullet",
      "User's shop is in McKinney",
      "Does the user prefer tea? He does!",
    ];
    expect(splitDeclaredFacts(joinFactsForPromotion(items))).toEqual(items);
  });

  it("holds after the newline collapse that makes one line == one fact", () => {
    const items = ["User speaks Spanish\nand some French", "User lives in Texas"];
    const normalized = items.map(normalizeFactLine);
    expect(normalized).toEqual(["User speaks Spanish and some French", "User lives in Texas"]);
    // The collapse is what guarantees identity: a smuggled interior newline
    // cannot become a second derived fact.
    expect(splitDeclaredFacts(joinFactsForPromotion(items))).toEqual(normalized);
  });

  it("derives exactly N facts from N items no matter how many sentences they carry", () => {
    const items = Array.from({ length: 12 }, (_, i) => `Alpha ${i}. Beta ${i}. Gamma ${i}. Delta ${i}.`);
    expect(splitDeclaredFacts(joinFactsForPromotion(items))).toHaveLength(12);
  });

  it("drops empty items on both sides so the count stays consistent", () => {
    expect(splitDeclaredFacts(joinFactsForPromotion(["a real fact", "   ", ""]))).toEqual(["a real fact"]);
  });
});

describe("single-content blob path still splits (regression)", () => {
  it("splits a multi-line blob and strips list markers", () => {
    expect(splitMultiFactBlob("- User owns a shop\n- User prefers terse replies")).toEqual([
      "User owns a shop",
      "User prefers terse replies",
    ]);
  });

  it("splits an undeclared 4-sentence single line at sentence boundaries", () => {
    expect(splitMultiFactBlob("One. Two. Three. Four.")).toEqual(["One.", "Two.", "Three.", "Four."]);
  });
});
