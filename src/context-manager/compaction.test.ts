import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { StreamEvent } from "../anthropic-client/types.js";

// Regression for the compaction data-loss bug: when the summarizer backend is
// unauthenticated, the Claude CLI surfaces "Not logged in · Please run /login".
// That error text was being accepted as an LLM "summary" and persisted OVER ~30
// real messages (irreversible loss) instead of falling back to the deterministic
// digest. summarizeOldMessages must return null on ANY transport failure.
//
// We stub the real seam the classifier consumes (streamAnthropicResponse) rather
// than mocking classifyWithLLM itself, so the guard that converts a transport
// `error` event into a failed (null) classification is exercised end to end.

// Per-call event queues for the stubbed Anthropic transport: call N of
// classifyWithLLM consumes transportCalls[N-1]. The user prompt of every call
// is captured so the retry-with-feedback wiring can be asserted.
let transportCalls: StreamEvent[][] = [];
let capturedPrompts: string[] = [];

vi.mock("../providers/resolve-provider-context.js", () => ({
  resolveProviderContext: vi.fn(async () => ({
    provider: "anthropic",
    apiKey: "cli",
    model: "claude-opus-4-6",
  })),
}));

vi.mock("../anthropic-client/index.js", () => ({
  // eslint-disable-next-line require-yield
  streamAnthropicResponse: vi.fn(async function* (args: {
    messages: { content: string }[];
  }): AsyncGenerator<StreamEvent> {
    capturedPrompts.push(String(args.messages[0]?.content ?? ""));
    const events = transportCalls.shift() ?? [];
    for (const ev of events) yield ev;
  }),
}));

import { buildSummaryTranscript, summarizeOldMessages } from "./compaction.js";
import { RETRIEVAL_RESULTS_INSTRUCTION } from "../harness-text.js";

const OLD_MESSAGES: ChatCompletionMessageParam[] = Array.from(
  { length: 30 },
  (_, i) =>
    (i % 2 === 0
      ? { role: "user", content: `user message ${i}` }
      : { role: "assistant", content: `assistant message ${i}` }) as ChatCompletionMessageParam,
);

describe("summarizeOldMessages — an auth-error backend must never become a summary", () => {
  beforeEach(() => {
    transportCalls = [];
    capturedPrompts = [];
  });

  it("returns null when the CLI transport reports a logged-out auth error", async () => {
    // Post-fix transport surfaces the logged-out CLI as a structured error
    // event. summarizeOldMessages must return null so the /api/compact route
    // falls back to the deterministic [User]/[Agent] digest instead of
    // persisting "Not logged in · Please run /login" as the conversation.
    transportCalls = [[{ type: "error", error: "Not logged in · Please run /login" }]];
    const summary = await summarizeOldMessages(OLD_MESSAGES);
    expect(summary).toBeNull();
    // A transport failure is terminal — the rewrite guard must NOT burn a
    // second 30s attempt on a backend that already declined.
    expect(capturedPrompts).toHaveLength(1);
  });

  it("returns null even if a partial reply streamed before the error", async () => {
    // A mid-stream failure (partial text, then an error) is still a failure —
    // a truncated half-summary must NOT be accepted as the compaction digest.
    // This fails without the classifier's error-event guard (the partial text
    // would be returned as a real summary).
    transportCalls = [
      [
        { type: "text", delta: "Partial summary that never fin" },
        { type: "error", error: "network error mid-stream" },
      ],
    ];
    const summary = await summarizeOldMessages(OLD_MESSAGES);
    expect(summary).toBeNull();
  });

  it("still returns a real summary on the happy path (no regression)", async () => {
    transportCalls = [
      [
        { type: "text", delta: "User asked X; agent did Y; constraint Z remains open." },
        { type: "done" },
      ],
    ];
    const summary = await summarizeOldMessages(OLD_MESSAGES);
    expect(summary).toBe("User asked X; agent did Y; constraint Z remains open.");
    expect(capturedPrompts).toHaveLength(1);
  });
});

describe("summarizeOldMessages — degenerate-output guard (looping model output)", () => {
  // Single-line short-period repetition: gzips to ~2% of its size, so
  // detectDegenerateRewrite's compression check flags it as looping output.
  const LOOPING_SUMMARY = "DECISIONS: the same bullet again. ".repeat(120);

  beforeEach(() => {
    transportCalls = [];
    capturedPrompts = [];
  });

  it("retries a looping first output with rejection feedback, then accepts the fix", async () => {
    transportCalls = [
      [{ type: "text", delta: LOOPING_SUMMARY }, { type: "done" }],
      [{ type: "text", delta: "DECISIONS: use vitest. CONSTRAINTS: none." }, { type: "done" }],
    ];
    const summary = await summarizeOldMessages(OLD_MESSAGES);
    expect(summary).toBe("DECISIONS: use vitest. CONSTRAINTS: none.");
    expect(capturedPrompts).toHaveLength(2);
    // The second attempt's prompt carries the rejection reason so the model
    // can steer away from the failure, while still containing the transcript.
    expect(capturedPrompts[1]).toMatch(/previous summary was rejected/);
    expect(capturedPrompts[1]).toMatch(/loop/i);
    expect(capturedPrompts[1]).toContain("user message 0");
  });

  it("returns null (breaker food) when both attempts loop — never a degenerate summary", async () => {
    transportCalls = [
      [{ type: "text", delta: LOOPING_SUMMARY }, { type: "done" }],
      [{ type: "text", delta: LOOPING_SUMMARY }, { type: "done" }],
    ];
    const summary = await summarizeOldMessages(OLD_MESSAGES);
    expect(summary).toBeNull();
    // Hard bound: exactly maxAttempts (2) calls, never a third.
    expect(capturedPrompts).toHaveLength(2);
  });
});

describe("summarizeOldMessages — bounded transcript (local 16k dispatch window)", () => {
  beforeEach(() => {
    transportCalls = [];
    capturedPrompts = [];
  });

  it("clips tool results so the prompt fits, keeping every user constraint", async () => {
    const snapshot = "x".repeat(40_000);
    const heavy: ChatCompletionMessageParam[] = [
      { role: "user", content: "never touch mail from jenny" },
      ...Array.from({ length: 30 }, (_, i) =>
        (i % 2 === 0
          ? { role: "assistant", content: `[called browser({"action":"snapshot"})]` }
          : { role: "user", content: `[tool result] ${snapshot}` }) as ChatCompletionMessageParam),
      { role: "user", content: "also skip anything with attachments" },
    ];
    const transcript = buildSummaryTranscript(heavy);
    expect(transcript.length).toBeLessThanOrEqual(30_000 + 200);
    expect(transcript).toContain("never touch mail from jenny");
    expect(transcript).toContain("also skip anything with attachments");
  });

  // 2026-09-23: memory_search's envelope is ~480 chars of harness instruction,
  // longer than a tool row's whole 400-char allowance. The clip kept the
  // envelope and cut every retrieved value, so a compacted history showed a
  // search that had "returned" nothing but its own disclaimer.
  it("spends a tool row's budget on retrieved facts, not on the harness envelope", () => {
    const hit = "[1] source=entity:a1c — Total T 891 ng/dL, Free T 19.1 pg/mL (from 14.6 then 8.6)";
    const wrapped =
      `<search_results count="6" query="testosterone test levels trend">
` +
      `${RETRIEVAL_RESULTS_INSTRUCTION}

` +
      `${hit}
` +
      `</search_results>`;
    expect(wrapped.indexOf("891")).toBeGreaterThan(400);

    const transcript = buildSummaryTranscript([{ role: "tool", tool_call_id: "t1", content: wrapped } as ChatCompletionMessageParam]);

    expect(transcript).toContain("891");
    expect(transcript).not.toContain("DO NOT paste these snippets verbatim");
    expect(transcript).not.toContain("<search_results");
  });

  it("drops the oldest non-user rows before any user row when clipping is not enough", () => {
    const rows: ChatCompletionMessageParam[] = [
      { role: "user", content: "constraint A" },
      ...Array.from({ length: 200 }, () => ({ role: "assistant", content: "y".repeat(800) }) as ChatCompletionMessageParam),
      { role: "user", content: "constraint B" },
    ];
    const transcript = buildSummaryTranscript(rows);
    expect(transcript.length).toBeLessThanOrEqual(30_000 + 200);
    expect(transcript).toMatch(/^\[\d+ older messages omitted/);
    expect(transcript).toContain("constraint A");
    expect(transcript).toContain("constraint B");
  });

  it("rejects a reply that continues the conversation instead of summarizing", async () => {
    const continuation = "I've selected the matching promotion messages. Now I'll archive them.\n\n[called browser({\"action\":\"click\",\"ref\":867})]";
    transportCalls = [
      [{ type: "text", delta: continuation }, { type: "done" }],
      [{ type: "text", delta: continuation }, { type: "done" }],
    ];
    expect(await summarizeOldMessages(OLD_MESSAGES)).toBeNull();
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).toMatch(/continued the conversation/);
  });
});

// muse, grade-school, run 20: the summarizer answered NOTHING_NOTABLE — the
// prompt's escape hatch for an EMPTY stretch — for 56 messages of file reads,
// test runs and its own analysis of a failing suite. That one word replaced
// ~8,900 tokens of history, and the model then re-read the same files up to 30
// times in a run.
describe("summarizeOldMessages — 'nothing notable' over real work is rejected", () => {
  const text = (delta: string): StreamEvent[] => [{ type: "text", delta } as StreamEvent];
  // A segment with real work in it: tool results and analysis, not chatter.
  const WORK: ChatCompletionMessageParam[] = Array.from({ length: 12 }, (_, i) => (
    i % 2 === 0
      ? { role: "user", content: `[tool result] [ok, path="C:/w/grade_school.py", bytes=680] class School:
    def added(self):
        return list(self._names)  # line ${i} of the file the agent just read` }
      : { role: "assistant", content: `[called bash({"command":"python -m unittest grade_school_test"})] the suite fails: added() returns names where the tests expect booleans, attempt ${i}` }
  ) as ChatCompletionMessageParam);

  beforeEach(() => {
    transportCalls = [];
    capturedPrompts = [];
  });

  it("retries with feedback, and takes the corrected summary", async () => {
    transportCalls = [text("NOTHING_NOTABLE"), text("CURRENT_TASK_STATE: mid-way through fixing added().")];
    const out = await summarizeOldMessages(WORK);
    expect(out).toMatch(/CURRENT_TASK_STATE/);
    expect(capturedPrompts[1]).toMatch(/real work|summarize what was decided/i);
  });

  it("returns null when it insists, so the caller keeps history instead of a summary that says nothing", async () => {
    transportCalls = [text("NOTHING_NOTABLE"), text("NOTHING_NOTABLE")];
    expect(await summarizeOldMessages(WORK)).toBeNull();
  });

  it("still accepts it for a genuinely thin segment", async () => {
    transportCalls = [text("NOTHING_NOTABLE")];
    const thin: ChatCompletionMessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(await summarizeOldMessages(thin)).toBe("NOTHING_NOTABLE");
  });
});
