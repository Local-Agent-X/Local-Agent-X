import { describe, it, expect } from "vitest";
import { detectRefusalText } from "../src/response-classifier.js";

describe("detectRefusalText — leading-anchor matches", () => {
  it("matches 'I cannot help with that'", () => {
    const r = detectRefusalText("I cannot help with that request.");
    expect(r.isRefusal).toBe(true);
    expect(r.snippet).toMatch(/i cannot help/i);
    expect(r.pattern).toBeTruthy();
  });

  it("matches 'I won't generate'", () => {
    const r = detectRefusalText("I won't generate that for you.");
    expect(r.isRefusal).toBe(true);
  });

  it("matches 'I'm sorry, but I cannot'", () => {
    const r = detectRefusalText("I'm sorry, but I cannot comply with that.");
    expect(r.isRefusal).toBe(true);
  });

  it("matches 'I apologize'", () => {
    const r = detectRefusalText("I apologize, this falls outside what I can do.");
    expect(r.isRefusal).toBe(true);
  });

  it("matches 'Sorry, but I can't'", () => {
    const r = detectRefusalText("Sorry, but I can't help with that.");
    expect(r.isRefusal).toBe(true);
  });

  it("matches 'against my guidelines' anywhere in head", () => {
    const r = detectRefusalText("That request goes against my guidelines.");
    expect(r.isRefusal).toBe(true);
  });

  it("matches 'violates the content policy'", () => {
    const r = detectRefusalText("That violates the content policy I follow.");
    expect(r.isRefusal).toBe(true);
  });
});

describe("detectRefusalText — non-refusal text", () => {
  it("does not match a normal completion", () => {
    const r = detectRefusalText("Sure, here is the function you asked for.");
    expect(r.isRefusal).toBe(false);
  });

  it("does not match 'I cannot' if used in a non-refusal sense mid-sentence", () => {
    const r = detectRefusalText("Here is the answer. Note that I cannot guarantee performance on edge cases.");
    expect(r.isRefusal).toBe(false);
  });

  it("ignores 'I'm sorry' when not paired with refusal verb", () => {
    const r = detectRefusalText("I'm sorry that took so long. Here is the result you wanted.");
    expect(r.isRefusal).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(detectRefusalText("").isRefusal).toBe(false);
  });

  it("returns false for whitespace-only", () => {
    expect(detectRefusalText("   \n  \t").isRefusal).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(detectRefusalText(undefined).isRefusal).toBe(false);
  });

  it("returns false for null", () => {
    expect(detectRefusalText(null).isRefusal).toBe(false);
  });
});

describe("detectRefusalText — length-based conservative bias", () => {
  it("ignores long answers that happen to mention refusal phrases mid-text", () => {
    const filler = "Here is a detailed walkthrough of the algorithm. ".repeat(20);
    const text = filler + "I cannot guarantee correctness in all cases. " + filler;
    expect(text.length).toBeGreaterThan(600);
    const r = detectRefusalText(text);
    expect(r.isRefusal).toBe(false);
  });

  it("still flags short refusals that lead the response", () => {
    const r = detectRefusalText("I cannot help with that. Here are some safer alternatives instead.");
    expect(r.isRefusal).toBe(true);
  });

  it("flags refusal at the start even if total length is moderate (<600)", () => {
    const tail = " The reason is that this involves restricted material that I'm not configured to produce.";
    const r = detectRefusalText("I won't help with creating that." + tail);
    expect(r.isRefusal).toBe(true);
  });
});

describe("detectRefusalText — case insensitivity", () => {
  it("matches uppercase refusals", () => {
    const r = detectRefusalText("I CANNOT HELP WITH THAT.");
    expect(r.isRefusal).toBe(true);
  });

  it("matches mixed-case refusals", () => {
    const r = detectRefusalText("I Cannot Help With That.");
    expect(r.isRefusal).toBe(true);
  });
});

describe("detectRefusalText — return shape", () => {
  it("returns pattern and snippet on match", () => {
    const r = detectRefusalText("I cannot assist with that.");
    expect(r.isRefusal).toBe(true);
    expect(typeof r.pattern).toBe("string");
    expect(typeof r.snippet).toBe("string");
    expect(r.snippet!.length).toBeLessThanOrEqual(120);
  });

  it("omits pattern/snippet when no match", () => {
    const r = detectRefusalText("Looks great, thanks!");
    expect(r.isRefusal).toBe(false);
    expect(r.pattern).toBeUndefined();
    expect(r.snippet).toBeUndefined();
  });
});
