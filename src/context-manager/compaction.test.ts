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

// Events the stubbed Anthropic transport emits for the next classify call.
let transportEvents: StreamEvent[] = [];

vi.mock("../providers/resolve-provider-context.js", () => ({
  resolveProviderContext: vi.fn(async () => ({
    provider: "anthropic",
    apiKey: "cli",
    model: "claude-opus-4-6",
  })),
}));

vi.mock("../anthropic-client/index.js", () => ({
  // eslint-disable-next-line require-yield
  streamAnthropicResponse: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
    for (const ev of transportEvents) yield ev;
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
    transportEvents = [];
  });

  it("returns null when the CLI transport reports a logged-out auth error", async () => {
    // Post-fix transport surfaces the logged-out CLI as a structured error
    // event. summarizeOldMessages must return null so the /api/compact route
    // falls back to the deterministic [User]/[Agent] digest instead of
    // persisting "Not logged in · Please run /login" as the conversation.
    transportEvents = [{ type: "error", error: "Not logged in · Please run /login" }];
    const summary = await summarizeOldMessages(OLD_MESSAGES);
    expect(summary).toBeNull();
  });

  it("returns null even if a partial reply streamed before the error", async () => {
    // A mid-stream failure (partial text, then an error) is still a failure —
    // a truncated half-summary must NOT be accepted as the compaction digest.
    // This fails without the classifier's error-event guard (the partial text
    // would be returned as a real summary).
    transportEvents = [
      { type: "text", delta: "Partial summary that never fin" },
      { type: "error", error: "network error mid-stream" },
    ];
    const summary = await summarizeOldMessages(OLD_MESSAGES);
    expect(summary).toBeNull();
  });

  it("still returns a real summary on the happy path (no regression)", async () => {
    transportEvents = [
      { type: "text", delta: "User asked X; agent did Y; constraint Z remains open." },
      { type: "done" },
    ];
    const summary = await summarizeOldMessages(OLD_MESSAGES);
    expect(summary).toBe("User asked X; agent did Y; constraint Z remains open.");
  });
});
