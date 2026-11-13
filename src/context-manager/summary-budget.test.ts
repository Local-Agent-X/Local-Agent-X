// The compaction summarizer reads and writes in proportion to a hosted model's
// window, and keeps the 30k-character bound on a local or custom endpoint.
import { describe, expect, it } from "vitest";
import { LOCAL_SUMMARY_BUDGET, summaryBudgetFor } from "./summary-budget.js";
import { buildSummaryTranscript } from "./compaction.js";

describe("summaryBudgetFor", () => {
  it("keeps the local bound for local and custom endpoints, and when the window is unknown", () => {
    expect(summaryBudgetFor("local", 1_000_000)).toEqual(LOCAL_SUMMARY_BUDGET);
    expect(summaryBudgetFor("custom", 1_000_000)).toEqual(LOCAL_SUMMARY_BUDGET);
    expect(summaryBudgetFor("anthropic", undefined)).toEqual(LOCAL_SUMMARY_BUDGET);
    expect(summaryBudgetFor(undefined, 1_000_000)).toEqual(LOCAL_SUMMARY_BUDGET);
  });

  it("a 1M-token hosted window reads up to the cap, with clips, reply and timeout capped too", () => {
    const b = summaryBudgetFor("anthropic", 1_000_000);
    expect(b.transcriptChars).toBe(360_000);
    expect(b.rowChars).toEqual({ user: 16_000, assistant: 6_400, tool: 3_200 });
    expect(b.replyChars).toBe(24_000);
    expect(b.timeoutMs).toBe(120_000);
  });

  it("scales with a mid-size window", () => {
    const b = summaryBudgetFor("xai", 200_000);
    expect(b.transcriptChars).toBe(150_000);
    expect(b.rowChars.tool).toBe(2_000);
    expect(b.timeoutMs).toBe(75_000);
  });

  it("never reads less than the local bound", () => {
    expect(summaryBudgetFor("openai", 32_000).transcriptChars).toBe(LOCAL_SUMMARY_BUDGET.transcriptChars);
  });
});

describe("buildSummaryTranscript with a budget", () => {
  const long = "x".repeat(3_000);
  it("a hosted budget keeps far more of a tool result than the local one", () => {
    const rows = [{ role: "tool" as const, tool_call_id: "c", content: long }];
    const local = buildSummaryTranscript(rows);
    const hosted = buildSummaryTranscript(rows, summaryBudgetFor("anthropic", 1_000_000));
    expect(local).toContain("chars clipped");
    expect(hosted).not.toContain("chars clipped");
  });
});
