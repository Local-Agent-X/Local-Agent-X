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

import { summarizeOldMessages } from "./compaction.js";

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
