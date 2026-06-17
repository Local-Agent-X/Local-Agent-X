import { describe, it, expect } from "vitest";
import {
  looksLikeClarificationRequest,
  looksLikeUnsubstantiatedCompletion,
  looksLikeEmptyOrErrorOnly,
} from "./result-guard.js";

describe("looksLikeUnsubstantiatedCompletion", () => {
  it("fires on a committing claim with no committed work", () => {
    const v = looksLikeUnsubstantiatedCompletion("Saved everything to memory. ✅ Done.", false);
    expect(v.isUnsubstantiated).toBe(true);
    expect(v.matchedPhrase).toBeTruthy();
  });

  it("never fires when committedWork is true", () => {
    const v = looksLikeUnsubstantiatedCompletion("Saved everything to memory. ✅ Done.", true);
    expect(v.isUnsubstantiated).toBe(false);
  });

  it("does not fire on a research/recommendation report with no committing verb", () => {
    const v = looksLikeUnsubstantiatedCompletion(
      "...based on this analysis I recommend X.",
      false,
    );
    expect(v.isUnsubstantiated).toBe(false);
  });

  it("does not throw or fire on empty input", () => {
    const v = looksLikeUnsubstantiatedCompletion("", false);
    expect(v.isUnsubstantiated).toBe(false);
  });
});

describe("looksLikeClarificationRequest", () => {
  it("still flags clarification asks", () => {
    const v = looksLikeClarificationRequest("Please send the topic.");
    expect(v.isClarificationRequest).toBe(true);
  });
});

describe("looksLikeEmptyOrErrorOnly", () => {
  it("flags empty output", () => {
    expect(looksLikeEmptyOrErrorOnly("").isEmptyOrErrorOnly).toBe(true);
    expect(looksLikeEmptyOrErrorOnly("   \n  ").isEmptyOrErrorOnly).toBe(true);
  });

  it("flags a status-marker-only result with no body", () => {
    const v = looksLikeEmptyOrErrorOnly("[Agent timed out]");
    expect(v.isEmptyOrErrorOnly).toBe(true);
    expect(v.reason).toMatch(/status marker/);
  });

  it("does not flag a status marker followed by a real body", () => {
    const v = looksLikeEmptyOrErrorOnly("[Agent timed out]\n\nHere is what I found before timing out: ...");
    expect(v.isEmptyOrErrorOnly).toBe(false);
  });

  it("does not flag a normal report", () => {
    const v = looksLikeEmptyOrErrorOnly("Completed the analysis. Revenue grew 12% QoQ.");
    expect(v.isEmptyOrErrorOnly).toBe(false);
  });
});
