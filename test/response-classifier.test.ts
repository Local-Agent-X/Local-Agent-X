import { describe, it, expect } from "vitest";
import { detectRefusalText } from "../src/response-classifier.js";

describe("detectRefusalText", () => {
  it("detects leading 'I cannot help'", () => {
    const r = detectRefusalText("I cannot help with that request.");
    expect(r.isRefusal).toBe(true);
    expect(r.snippet).toMatch(/cannot help/i);
    expect(r.pattern).toBeTruthy();
  });

  it("detects 'I can't assist'", () => {
    const r = detectRefusalText("I can't assist with creating malware.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'I cannot provide'", () => {
    const r = detectRefusalText("I cannot provide that information.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'I won't help'", () => {
    const r = detectRefusalText("I won't help with this.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'I'm sorry, but I cannot'", () => {
    const r = detectRefusalText("I'm sorry, but I cannot fulfill that request.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'I'm afraid I cannot'", () => {
    const r = detectRefusalText("I'm afraid I cannot do that.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'Sorry, I can't help'", () => {
    const r = detectRefusalText("Sorry, I can't help with that.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'Unfortunately, I cannot'", () => {
    const r = detectRefusalText("Unfortunately, I cannot do that for you.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'I apologize'", () => {
    const r = detectRefusalText("I apologize, but this falls outside what I can do.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'I must decline'", () => {
    const r = detectRefusalText("I must decline this request.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'against my guidelines' phrase", () => {
    const r = detectRefusalText("That request goes against my guidelines.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'against the policies' phrase", () => {
    const r = detectRefusalText("Doing that runs against the policies I follow.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'violates my content policy' phrase", () => {
    const r = detectRefusalText("Doing so violates my content policy.");
    expect(r.isRefusal).toBe(true);
  });

  it("detects 'I cannot in good conscience'", () => {
    const r = detectRefusalText("I cannot in good conscience write that for you.");
    expect(r.isRefusal).toBe(true);
  });

  it("does NOT misclassify a long answer that mentions sorry mid-text", () => {
    const longText = "Here is the algorithm you asked about. ".repeat(20)
      + "Note that I'm sorry the docs are sparse.";
    const r = detectRefusalText(longText);
    expect(r.isRefusal).toBe(false);
  });

  it("does NOT misclassify 'I cannot wait to help' (positive 'cannot')", () => {
    const r = detectRefusalText("I cannot wait to help you build this!");
    expect(r.isRefusal).toBe(false);
  });

  it("does NOT misclassify a normal answer", () => {
    const r = detectRefusalText("Sure, here's the function you asked for: ...");
    expect(r.isRefusal).toBe(false);
  });

  it("does NOT misclassify a code answer that contains 'cannot' in a string", () => {
    const r = detectRefusalText("function fn() { throw new Error('cannot proceed'); }");
    expect(r.isRefusal).toBe(false);
  });

  it("returns false for empty / null / undefined / whitespace text", () => {
    expect(detectRefusalText("").isRefusal).toBe(false);
    expect(detectRefusalText(null).isRefusal).toBe(false);
    expect(detectRefusalText(undefined).isRefusal).toBe(false);
    expect(detectRefusalText("   \n\t").isRefusal).toBe(false);
  });

  it("does NOT fire on a >600 char body even if it contains a refusal phrase", () => {
    const filler = "x".repeat(700);
    const r = detectRefusalText("I cannot help. " + filler);
    expect(r.isRefusal).toBe(false);
  });

  it("trims leading whitespace before checking patterns", () => {
    const r = detectRefusalText("\n\n  I cannot help with that request.");
    expect(r.isRefusal).toBe(true);
  });

  it("returns the matched snippet (first 120 chars)", () => {
    const r = detectRefusalText("I'm sorry, but I cannot fulfill this request because of policy.");
    expect(r.isRefusal).toBe(true);
    expect(r.snippet).toBeTruthy();
    expect((r.snippet || "").length).toBeLessThanOrEqual(120);
  });
});
