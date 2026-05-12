import { describe, it, expect } from "vitest";

import { runParityFixture } from "../src/agent-loop/eval/runner.js";
import type { Fixture } from "../src/agent-loop/eval/types.js";

/**
 * Parity smoke: the simplest possible chat turn — user says hi, model
 * replies with text only, no tools. If THIS diffs between the legacy
 * (runStandardAgent) and unified (runAgentTurn) loops, every richer
 * fixture will diff too — this is the floor.
 *
 * Once this passes, layer on fixtures with tool calls, multi-iteration
 * loops, error paths, etc. Each new fixture pins one more contract.
 */
const textOnlyHappyPath: Fixture = {
  name: "text-only-happy-path",
  description: "User greets, model replies with text only, end_turn.",
  input: {
    userMessage: "Hello",
    systemPrompt: "You are a helpful assistant. Keep replies short.",
    tools: [],
    maxIterations: 3,
  },
  responses: [
    [
      { type: "text", delta: "Hi! " },
      { type: "text", delta: "How can I help?" },
      { type: "usage", promptTokens: 10, completionTokens: 8 },
      { type: "done", stopReason: "stop" },
    ],
  ],
  expect: {
    stopReason: "end_turn",
    assistantContains: ["Hi!", "How can I help?"],
    toolCallsCount: 0,
  },
};

describe("agent-loop parity — text-only happy path", () => {
  it("legacy and unified produce the same stopReason, tool calls, and assistant text", async () => {
    const result = await runParityFixture(textOnlyHappyPath);

    // Surface the actual diff content if we fail — much more useful
    // than just "pass=false" when debugging the first real parity gap.
    if (!result.pass) {
      const legacyFail = result.legacy.assertionFailure;
      const unifiedFail = result.unified.assertionFailure;
      const details = [
        legacyFail ? `legacy assertion: ${legacyFail}` : null,
        unifiedFail ? `unified assertion: ${unifiedFail}` : null,
        ...result.diffs,
      ].filter(Boolean).join("\n  - ");
      throw new Error(`parity smoke failed:\n  - ${details}`);
    }

    expect(result.pass).toBe(true);
    expect(result.diffs).toEqual([]);
    expect(result.legacy.turn.stopReason).toBe("end_turn");
    expect(result.unified.turn.stopReason).toBe("end_turn");
  });
});
