import { describe, it, expect } from "vitest";
import {
  checkUngroundedCodebaseAdvice,
  hasFreshCodebaseEvidence,
  looksLikeCodebaseAdviceRequest,
  looksLikeImplementationAdvice,
} from "./codebase-advice.js";

describe("codebase advice grounding", () => {
  it("recognizes repo/harness implementation-direction requests", () => {
    expect(looksLikeCodebaseAdviceRequest(
      "Where do we still struggle as a harness, and what should we do next?",
    )).toBe(true);
    expect(looksLikeCodebaseAdviceRequest(
      "So what's the move? Should you actually read the code base to determine what we do next?",
    )).toBe(true);
  });

  it("does not fire on ordinary advice outside the codebase", () => {
    expect(looksLikeCodebaseAdviceRequest("What should I cook tonight?")).toBe(false);
    expect(looksLikeCodebaseAdviceRequest("Should we go to the store next?")).toBe(false);
  });

  it("recognizes concrete implementation advice", () => {
    expect(looksLikeImplementationAdvice(
      "The move is to add a verifier middleware and wire it into the canonical loop.",
    )).toBe(true);
    expect(looksLikeImplementationAdvice(
      "We should implement a stale-docs gate and add tests.",
    )).toBe(true);
    expect(looksLikeImplementationAdvice(
      "Next concrete harness fix: Make agent_redirect reliably reach the canonical inject queue.",
    )).toBe(true);
  });

  it("does not nudge when the assistant explicitly says it must inspect first", () => {
    expect(looksLikeImplementationAdvice(
      "I need to read the codebase before recommending the next harness change.",
    )).toBe(false);
  });

  it("counts successful code inspection tools as fresh evidence", () => {
    expect(hasFreshCodebaseEvidence(new Set(["read"]))).toBe(true);
    expect(hasFreshCodebaseEvidence(new Set(["grep"]))).toBe(true);
    expect(hasFreshCodebaseEvidence(new Set(["glob"]))).toBe(true);
    expect(hasFreshCodebaseEvidence(new Set(["bash"]))).toBe(true);
    expect(hasFreshCodebaseEvidence(new Set(["memory_search"]))).toBe(false);
    expect(hasFreshCodebaseEvidence(new Set(["tool_search"]))).toBe(false);
  });

  it("nudges when implementation advice is given without reading current code", () => {
    const nudge = checkUngroundedCodebaseAdvice(
      "Where do we still struggle as a harness?",
      "We should add a verifier middleware next.",
      new Set(),
    );
    expect(nudge).toContain("without fresh code evidence");
  });

  it("stays quiet once current code was inspected", () => {
    const nudge = checkUngroundedCodebaseAdvice(
      "Where do we still struggle as a harness?",
      "We should add a verifier middleware next.",
      new Set(["grep"]),
    );
    expect(nudge).toBeNull();
  });
});
