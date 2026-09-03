import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { StreamEvent } from "../src/anthropic-client/types.js";

// Seam coverage for the degenerate-output guard (context-manager/
// llm-rewrite-guard.ts) on the CHAT lane.
//
// providers/sanitize.ts was split and the working-window summary now lives in
// providers/truncate-history.ts, which reaches the guard only indirectly:
//   scheduleSummaryRefresh → summarizeOldMessages → guardedRewrite.
//
// The sibling suite (truncate-history-preserves-constraints.test.ts) mocks
// summarizeOldMessages outright, so it proves the WIRING but never executes the
// guard. This suite stubs the TRANSPORT instead and drives a genuinely
// degenerate (looping) model output through the real seam end to end, because
// a degenerate summary here fails SILENTLY: the background refresh caches it
// and folds it into <prior_summary> on the next turn, replacing real history
// with no user-visible error and no failed call for the caller to notice.

// Per-call event queues for the stubbed Anthropic transport: call N of
// classifyWithLLM consumes transportCalls[N-1]. Every user prompt is captured
// so the retry-with-feedback ladder can be asserted.
let transportCalls: StreamEvent[][] = [];
let capturedPrompts: string[] = [];

vi.mock("../src/providers/resolve-provider-context.js", () => ({
  resolveProviderContext: vi.fn(async () => ({
    provider: "anthropic",
    apiKey: "cli",
    model: "claude-opus-4-6",
  })),
}));

vi.mock("../src/anthropic-client/index.js", () => ({
  // eslint-disable-next-line require-yield
  streamAnthropicResponse: vi.fn(async function* (args: {
    messages: { content: string }[];
  }): AsyncGenerator<StreamEvent> {
    capturedPrompts.push(String(args.messages[0]?.content ?? ""));
    const events = transportCalls.shift() ?? [];
    for (const ev of events) yield ev;
  }),
}));

import { truncateHistory, awaitPendingHistorySummaries } from "../src/providers/sanitize.js";

// Single-line short-period repetition: gzips to ~2% of its size, so the guard's
// compression check flags it as looping. 3960 chars — under classifyWithLLM's
// 6000-char response cap, so the transport cap is not what rejects it.
const LOOPING_SUMMARY = "DECISIONS: the same bullet again. ".repeat(120);
const GOOD_SUMMARY =
  "DECISIONS: use vitest.\nCONSTRAINTS: do NOT use axios; output must be report-final.csv.";

const CONSTRAINT = "HARD CONSTRAINT: do NOT use axios, and the output MUST be report-final.csv.";

function filler(count: number, start = 0): ChatCompletionMessageParam[] {
  const msgs: ChatCompletionMessageParam[] = [];
  for (let i = start; i < start + count; i++) {
    msgs.push({ role: "assistant", content: `working on step ${i}` });
    msgs.push({ role: "user", content: `continue step ${i}` });
  }
  return msgs;
}

// The summary cache is keyed on the FIRST old message, so each test uses a
// distinct leader to stay isolated from its neighbours.
function historyWith(leader: string, fillerStart: number): ChatCompletionMessageParam[] {
  return [{ role: "user", content: `${leader} ${CONSTRAINT}` }, ...filler(30, fillerStart)];
}

function summaryOf(out: ChatCompletionMessageParam[]): string {
  expect(out[0]?.role).toBe("system");
  return out[0]?.content as string;
}

const savedVitest = process.env.VITEST;
const savedNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  transportCalls = [];
  capturedPrompts = [];
  // The background-refresh path is guarded off under test runners so other
  // suites never fire real LLM calls; clear the guard here — the transport is
  // stubbed above, so nothing real can leave the process.
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
});

afterEach(async () => {
  await awaitPendingHistorySummaries();
  if (savedVitest !== undefined) process.env.VITEST = savedVitest;
  if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
});

describe("truncateHistory — degenerate-output guard fires on the chat-lane summary seam", () => {
  it("never caches a looping summary, and the deterministic digest keeps covering", async () => {
    transportCalls = [
      [{ type: "text", delta: LOOPING_SUMMARY }, { type: "done" }],
      [{ type: "text", delta: LOOPING_SUMMARY }, { type: "done" }],
    ];
    const history = historyWith("Build the export feature.", 500);

    truncateHistory(history, 30);
    await awaitPendingHistorySummaries();

    // The guard rejected attempt 1, retried once with feedback, then gave up.
    // Hard bound: exactly maxAttempts (2) transport calls, never a third.
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).toMatch(/previous summary was rejected/);
    expect(capturedPrompts[1]).toMatch(/loop/i);

    // Nothing was cached, so the next turn carries NO <prior_summary> — the
    // looping text never reaches the model as "earlier conversation".
    const summary = summaryOf(truncateHistory(history, 30));
    expect(summary).not.toContain("<prior_summary");
    expect(summary).not.toContain("the same bullet again");
    // …and the deterministic digest still preserves the user's constraint.
    expect(summary).toContain("do NOT use axios");
    expect(summary).toContain("report-final.csv");
  });

  it("accepts the retry's clean summary and folds it into the next turn's digest", async () => {
    transportCalls = [
      [{ type: "text", delta: LOOPING_SUMMARY }, { type: "done" }],
      [{ type: "text", delta: GOOD_SUMMARY }, { type: "done" }],
    ];
    const history = historyWith("Ship the importer.", 700);

    truncateHistory(history, 30);
    await awaitPendingHistorySummaries();
    expect(capturedPrompts).toHaveLength(2);

    const summary = summaryOf(truncateHistory(history, 30));
    expect(summary).toContain("<prior_summary");
    expect(summary).toContain("do NOT use axios; output must be report-final.csv");
    expect(summary).not.toContain("the same bullet again");

    // The cached summary covers the whole old segment, so no refresh is
    // scheduled and the transport is not called a third time.
    await awaitPendingHistorySummaries();
    expect(capturedPrompts).toHaveLength(2);
  });

  it("does not burn a second attempt when the transport itself declines", async () => {
    // A transport-level failure is terminal — feedback cannot fix a logged-out
    // backend, so the guard must not spend another 30s timeout on it.
    transportCalls = [[{ type: "error", error: "Not logged in · Please run /login" }]];
    const history = historyWith("Wire the dashboard.", 900);

    truncateHistory(history, 30);
    await awaitPendingHistorySummaries();

    expect(capturedPrompts).toHaveLength(1);
    expect(summaryOf(truncateHistory(history, 30))).not.toContain("<prior_summary");
  });
});
