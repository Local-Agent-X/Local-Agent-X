import { describe, it, expect } from "vitest";
import {
  looksLikeClarificationRequest,
  looksLikeUnsubstantiatedCompletion,
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
