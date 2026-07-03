import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// Mock the canonical LLM summarizer — same pattern as compact-history.test.ts.
// The mock intercepts sanitize.ts's dynamic import of the compaction module.
vi.mock("../src/context-manager/compaction.js", () => ({ summarizeOldMessages: vi.fn() }));

import { summarizeOldMessages } from "../src/context-manager/compaction.js";
import { truncateHistory, awaitPendingHistorySummaries } from "../src/providers/sanitize.js";

const mockSummarize = vi.mocked(summarizeOldMessages);

// Regression for CM-2: the auto-summary sliced every OLD user message to a
// 150-char first line, dropped tool results entirely, and never invoked the
// constraint-preserving LLM compactor — so a user constraint stated 45
// messages back reached the model as a meaningless fragment.

// The skeptic's break scenario: a realistic long app-build spec whose
// load-bearing constraints sit at the very END (~char 4000). Any head-only
// clip (150 chars pre-fix, 2000 chars in the refuted patch) drops them.
const TRAILING = "HARD CONSTRAINT: do NOT use any third-party HTTP client, and the output file MUST be named report-final.csv.";
const LONG_SPEC = `Build the export feature. ${"Here is more spec detail padding this message out well past every head-clip boundary. ".repeat(45)}${TRAILING}`;

// A mid-length constraint whose clauses sit past char 150 — the original
// finding's scenario. Must survive verbatim (no clipping at all).
const MEDIUM_CONSTRAINT =
  "Set up the exporter. " +
  "Some earlier framing that eats up the first chunk of characters so the important rules land well past the 150-char boundary the old digest sliced at. " +
  "It must support offline mode and retry failed uploads at most twice.";

function filler(count: number, start = 0): ChatCompletionMessageParam[] {
  const msgs: ChatCompletionMessageParam[] = [];
  for (let i = start; i < start + count; i++) {
    msgs.push({ role: "assistant", content: `working on step ${i}` });
    msgs.push({ role: "user", content: `continue step ${i}` });
  }
  return msgs;
}

const savedVitest = process.env.VITEST;
const savedNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  mockSummarize.mockReset();
  mockSummarize.mockResolvedValue(null);
  // The background-refresh path is guarded off under test runners (so other
  // suites never fire real LLM calls); clear the guard here — the summarizer
  // is mocked above, so nothing real can fire.
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
});

afterEach(async () => {
  await awaitPendingHistorySummaries();
  if (savedVitest !== undefined) process.env.VITEST = savedVitest;
  if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
});

function summaryOf(out: ChatCompletionMessageParam[]): string {
  expect(out[0]?.role).toBe("system");
  return out[0]?.content as string;
}

describe("truncateHistory — auto-summary preserves user constraints (CM-2)", () => {
  it("keeps a TRAILING constraint of a ~4000-char spec sent 45+ messages back", () => {
    const history: ChatCompletionMessageParam[] = [{ role: "user", content: LONG_SPEC }, ...filler(30)];
    expect(LONG_SPEC.length).toBeGreaterThan(3500);

    const summary = summaryOf(truncateHistory(history, 30));

    // Pre-fix: slice(0, 150) dropped this; the refuted head-only slice(0, 2000)
    // ALSO dropped it. Head+tail preservation must keep it.
    expect(summary).toContain("do NOT use any third-party HTTP client");
    expect(summary).toContain("report-final.csv");
    expect(summary).toMatch(/<prior_user>[^]*report-final\.csv[^]*<\/prior_user>/);
  });

  it("keeps a medium-length constraint fully verbatim (no clipping under head+tail bound)", () => {
    const history: ChatCompletionMessageParam[] = [{ role: "user", content: MEDIUM_CONSTRAINT }, ...filler(30, 100)];
    expect(MEDIUM_CONSTRAINT.length).toBeGreaterThan(150);

    const summary = summaryOf(truncateHistory(history, 30));

    expect(summary).toContain("must support offline mode and retry failed uploads at most twice");
    expect(summary).not.toContain("chars omitted"); // under the bound → verbatim, no marker
  });

  it("includes tool results in the digest instead of dropping them", () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "user", content: "run the migration and tell me the output path (tool-digest scenario)" },
      { role: "tool", tool_call_id: "call_1", content: "migration ok — wrote /tmp/out/migration-result.json" } as ChatCompletionMessageParam,
      ...filler(30, 200),
    ];

    const summary = summaryOf(truncateHistory(history, 30));

    // Pre-fix the digest loop skipped role==="tool" rows entirely.
    expect(summary).toContain("<prior_tool_result>");
    expect(summary).toContain("migration-result.json");
  });

  it("wires the canonical LLM summarizer into the live path (background refresh + reuse)", async () => {
    mockSummarize.mockResolvedValue("LLM DIGEST: user requires offline mode; do NOT use axios; output must be report-final.csv");
    const history: ChatCompletionMessageParam[] = [{ role: "user", content: LONG_SPEC }, ...filler(30, 300)];

    // First truncation schedules a background summary of the old segment.
    truncateHistory(history, 30);
    await awaitPendingHistorySummaries();
    expect(mockSummarize).toHaveBeenCalledTimes(1);

    // The summarizer must be fed the FULL old user message — not a fragment.
    const fed = mockSummarize.mock.calls[0][0];
    expect(fed.some((m) => typeof m.content === "string" && m.content.includes(TRAILING))).toBe(true);

    // Next turn folds the cached LLM summary into the digest…
    const summary = summaryOf(truncateHistory(history, 30));
    expect(summary).toContain("<prior_summary");
    expect(summary).toContain("LLM DIGEST: user requires offline mode");

    // …and does not re-summarize when the old segment hasn't grown.
    await awaitPendingHistorySummaries();
    expect(mockSummarize).toHaveBeenCalledTimes(1);
  });

  it("bounds pathological input so it cannot re-bloat the trimmed window", () => {
    const blob = `start-of-blob ${"x".repeat(50_000)}`;
    const msgs: ChatCompletionMessageParam[] = [{ role: "user", content: blob }];
    for (let i = 0; i < 20; i++) msgs.push({ role: "user", content: `big filler ${i} ${"y".repeat(3000)}` });
    msgs.push(...filler(20, 400));

    const summary = summaryOf(truncateHistory(msgs, 30));

    // Per-message head+tail clip is marked, and the TOTAL digest is budgeted.
    expect(summary).toContain("chars omitted");
    expect(summary.length).toBeLessThan(40_000);
  });
});
