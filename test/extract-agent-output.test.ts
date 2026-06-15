import { describe, it, expect } from "vitest";
import { extractAgentOutput } from "../src/server-utils.js";

// Regression for the cron mission "off-topic" false-failures (June 2026): the
// agent produced the full report in one turn, then took an extra turn and
// emitted a short completion-coda. The old extractor took the LAST assistant
// message >200 chars (the coda) and discarded the real report, which the
// off-topic validator then flagged. The extractor must return the report.
describe("extractAgentOutput", () => {
  const report = (
    "## NutriShop McKinney Supplement Trends Report\n\n" +
    "### 1. Trending ingredients\n" +
    "Creatine monohydrate, GLP-1 support stacks, marine collagen, and adaptogens.\n".repeat(20)
  ).trim();
  const coda = (
    "I've completed the scheduled task per its explicit instructions. My previous response is " +
    "the deliverable — a comprehensive 1000+ word report covering all five required sections, " +
    "drawn from peer-reviewed studies. No write or edit tool call is needed or appropriate; the " +
    "returned text itself is the report."
  ).trim();

  it("returns the report, not a trailing completion-coda", () => {
    const messages = [
      { role: "user", content: "Research supplement trends." },
      { role: "assistant", content: report },
      { role: "assistant", content: coda },
    ];
    expect(extractAgentOutput(messages)).toBe(report);
  });

  it("returns the report even when the coda itself clears the 200-char bar", () => {
    expect(coda.length).toBeGreaterThan(200);
    const messages = [
      { role: "user", content: "task" },
      { role: "assistant", content: report },
      { role: "assistant", content: coda },
    ];
    expect(extractAgentOutput(messages)).toBe(report);
  });

  it("ignores an earlier turn's longer answer in a multi-turn session", () => {
    const olderLongerAnswer = ("OLD TURN ANSWER. " + "filler ".repeat(500)).trim();
    const currentAnswer = (
      "CURRENT TURN ANSWER with enough substance to clear the substantial bar. " +
      "details ".repeat(40)
    ).trim();
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: olderLongerAnswer },
      { role: "user", content: "second question" },
      { role: "assistant", content: currentAnswer },
    ];
    expect(extractAgentOutput(messages)).toBe(currentAnswer);
  });

  it("falls back to joining when nothing clears the substantial bar", () => {
    const messages = [
      { role: "user", content: "task" },
      { role: "assistant", content: "short a" },
      { role: "assistant", content: "short b" },
    ];
    expect(extractAgentOutput(messages)).toBe("short a\n\nshort b");
  });

  it("falls back to tool output when there is no assistant text", () => {
    const messages = [
      { role: "user", content: "task" },
      { role: "tool", content: "fetched 12 sources with relevant market data points" },
    ];
    expect(extractAgentOutput(messages)).toContain("fetched 12 sources");
  });
});
