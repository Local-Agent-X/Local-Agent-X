import { describe, it, expect } from "vitest";
import {
  detectRefusalOrError,
  extractTopicKeywords,
  scoreTopicMatch,
  looksTruncated,
  validateMissionOutput,
} from "../src/cron/output-validation.js";

describe("detectRefusalOrError", () => {
  it("flags 'I cannot help' refusals", () => {
    const r = detectRefusalOrError("I cannot help with this request.");
    expect(r.refused).toBe(true);
  });

  it("flags 'I'm sorry' apology refusals", () => {
    const r = detectRefusalOrError("I'm sorry, I can't generate that content.");
    expect(r.refused).toBe(true);
  });

  it("flags rate-limit error messages", () => {
    expect(detectRefusalOrError("Error: rate limit exceeded").refused).toBe(true);
  });

  it("flags invalid api key errors", () => {
    expect(detectRefusalOrError("Authentication failed: invalid api key").refused).toBe(true);
  });

  it("does not flag substantive content", () => {
    expect(detectRefusalOrError("# Daily report\n\nHere is the analysis...").refused).toBe(false);
  });

  it("returns refused=false for empty input", () => {
    expect(detectRefusalOrError("").refused).toBe(false);
  });
});

describe("extractTopicKeywords", () => {
  it("strips stopwords and short tokens", () => {
    const kw = extractTopicKeywords("Research what is happening with autism therapy");
    expect(kw).toContain("autism");
    expect(kw).toContain("therapy");
    expect(kw).not.toContain("what");
    expect(kw).not.toContain("is");
  });

  it("dedupes repeated keywords", () => {
    const kw = extractTopicKeywords("autism autism autism research");
    expect(kw.filter(k => k === "autism")).toHaveLength(1);
  });

  it("caps at 25 keywords", () => {
    const big = Array.from({ length: 50 }, (_, i) => `keyword${i}`).join(" ");
    expect(extractTopicKeywords(big).length).toBeLessThanOrEqual(25);
  });
});

describe("scoreTopicMatch", () => {
  it("returns 1.0 score when keyword list is empty", () => {
    expect(scoreTopicMatch("", "anything").score).toBe(1);
  });

  it("scores full match at 1.0", () => {
    const r = scoreTopicMatch("autism therapy research", "autism therapy research findings");
    expect(r.score).toBe(1);
  });

  it("scores partial match proportionally", () => {
    const r = scoreTopicMatch("autism therapy cannabis sleep", "autism content here only");
    expect(r.matched).toBe(1);
    expect(r.total).toBe(4);
    expect(r.score).toBeCloseTo(0.25);
  });
});

describe("looksTruncated", () => {
  it("returns true for empty string", () => {
    expect(looksTruncated("")).toBe(true);
  });

  it("returns false for text ending in a period", () => {
    expect(looksTruncated("This is a complete sentence.")).toBe(false);
  });

  it("returns true for text ending mid-word", () => {
    expect(looksTruncated("This sentence was cut off at the wo")).toBe(true);
  });

  it("returns false for text ending in a closing quote", () => {
    expect(looksTruncated('He said "hello there."')).toBe(false);
  });

  it("returns false for text ending in a markdown heading", () => {
    expect(looksTruncated("intro text\n\n## Final Section Title")).toBe(false);
  });

  it("returns true for an empty list bullet", () => {
    expect(looksTruncated("- first item\n- second item\n-")).toBe(true);
  });

  it("returns false for a complete list item", () => {
    expect(looksTruncated("- first item\n- second item")).toBe(false);
  });

  it("returns false for a markdown table row", () => {
    expect(looksTruncated("| col1 | col2 |\n| a | b |")).toBe(false);
  });

  it("returns false for outputs over 1500 chars regardless of last char", () => {
    const longText = "Some report content. ".repeat(100) + "ending without punctuation";
    expect(longText.length).toBeGreaterThan(1500);
    expect(looksTruncated(longText)).toBe(false);
  });

  it("trims trailing whitespace before checking", () => {
    expect(looksTruncated("Complete sentence.   \n\n")).toBe(false);
  });
});

describe("validateMissionOutput", () => {
  const longBody = (extra = "") =>
    "# Report\n\n" + "Substantive paragraph about the topic. ".repeat(20) + extra;

  it("accepts a substantive end_turn report", () => {
    const r = validateMissionOutput("autism research update", longBody("All good."), "end_turn");
    expect(r.valid).toBe(true);
    expect(r.contentValid).toBe(true);
  });

  it("fails empty output with contentValid=false", () => {
    const r = validateMissionOutput("anything", "", "end_turn");
    expect(r.valid).toBe(false);
    expect(r.contentValid).toBe(false);
    expect(r.reason).toMatch(/empty/);
  });

  it("fails refusal with contentValid=false", () => {
    const r = validateMissionOutput("autism research", "I cannot help with this request.", "end_turn");
    expect(r.valid).toBe(false);
    expect(r.contentValid).toBe(false);
    expect(r.reason).toMatch(/refusal/);
  });

  it("fails too-short output with contentValid=false", () => {
    const r = validateMissionOutput("autism research", "Brief reply.", "end_turn");
    expect(r.valid).toBe(false);
    expect(r.contentValid).toBe(false);
    expect(r.reason).toMatch(/too short/);
  });

  it("accepts 200+ char output (lowered MIN_OUTPUT_LENGTH)", () => {
    const body = "Autism research findings. ".repeat(10);
    expect(body.length).toBeGreaterThanOrEqual(200);
    expect(body.length).toBeLessThan(400);
    const r = validateMissionOutput("autism research findings", body, "end_turn");
    expect(r.valid).toBe(true);
  });

  it("fails off-topic content with contentValid=false", () => {
    const prompt = "autism therapy cannabis sleep nutrition behavior communication sensory cannabinoid";
    const offTopic = "Today's weather forecast suggests rain in the afternoon. ".repeat(20);
    const r = validateMissionOutput(prompt, offTopic, "end_turn");
    expect(r.valid).toBe(false);
    expect(r.contentValid).toBe(false);
    expect(r.reason).toMatch(/off-topic/);
  });

  it("fails meta-pattern saying 'report saved' with contentValid=false", () => {
    const r = validateMissionOutput("research", "Report saved to /tmp/foo.md", "end_turn");
    expect(r.valid).toBe(false);
    expect(r.contentValid).toBe(false);
  });

  it("SALVAGE: substantive content with stopReason=error returns valid=false, contentValid=true", () => {
    const r = validateMissionOutput("autism research", longBody("Done."), "error");
    expect(r.valid).toBe(false);
    expect(r.contentValid).toBe(true);
    expect(r.reason).toMatch(/bad stopReason: error/);
  });

  it("SALVAGE: substantive content with stopReason=max_iterations also salvageable", () => {
    const r = validateMissionOutput("autism research", longBody("Done."), "max_iterations");
    expect(r.valid).toBe(false);
    expect(r.contentValid).toBe(true);
  });

  it("does not salvage when stopReason=error AND content is bad", () => {
    const r = validateMissionOutput("autism research", "I cannot help with this.", "error");
    expect(r.valid).toBe(false);
    expect(r.contentValid).toBe(false);
    expect(r.reason).toMatch(/refusal/);
  });

  it("long structured report ending without sentence punctuation still passes", () => {
    const lastLine = "## Watchlist for today";
    const body = "# Big Report\n\n" + "Paragraph content here. ".repeat(80) + "\n\n" + lastLine;
    expect(body.length).toBeGreaterThan(1500);
    const r = validateMissionOutput("market research watchlist", body, "end_turn");
    expect(r.valid).toBe(true);
  });

  it("cron preamble in prompt does not throw", () => {
    expect(() =>
      validateMissionOutput("every day at 8 am, research autism", longBody(), "end_turn"),
    ).not.toThrow();
  });
});
