import { describe, it, expect, afterEach } from "vitest";
import {
  classifyStepEffort,
  resolveStepReasoningEffort,
  MECHANICAL_TOOLS,
} from "./step-effort.js";
import type { CanonicalMessage } from "./contract-types.js";

// Shapes mirror what the loop actually stores: adapters finalize assistant
// rows with `content.toolCalls: [{id, name, arguments}]`; dispatch-tools.ts
// commits tool_result rows as `content: {toolCallId, result, status}`.
const user = (text: string): CanonicalMessage => ({ messageId: "u", role: "user", content: { text } });
const assistantCalling = (...calls: Array<{ id: string; name: string }>): CanonicalMessage => ({
  messageId: "a",
  role: "assistant",
  content: { text: "", toolCalls: calls.map(c => ({ ...c, arguments: "{}" })) },
});
const toolResult = (toolCallId: string, status?: string): CanonicalMessage => ({
  messageId: `tr-${toolCallId}`,
  role: "tool_result",
  content: { toolCallId, result: "content", ...(status !== undefined ? { status } : {}) },
});

const prevEnv = process.env.LAX_STEP_EFFORT;
afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_STEP_EFFORT;
  else process.env.LAX_STEP_EFFORT = prevEnv;
});

describe("classifyStepEffort", () => {
  it("classifies an all-ok file-mechanics trailing batch as mechanical", () => {
    const messages = [
      user("fix the bug"),
      assistantCalling({ id: "t1", name: "read" }, { id: "t2", name: "grep" }),
      toolResult("t1", "ok"),
      toolResult("t2", "ok"),
    ];
    expect(classifyStepEffort({ turnIdx: 2, messages })).toBe("mechanical");
  });

  it("stays standard when the batch mixes in a non-mechanical tool", () => {
    const messages = [
      user("fix the bug"),
      assistantCalling({ id: "t1", name: "read" }, { id: "t2", name: "bash" }),
      toolResult("t1", "ok"),
      toolResult("t2", "ok"),
    ];
    expect(classifyStepEffort({ turnIdx: 2, messages })).toBe("standard");
  });

  it("stays standard when any result failed — a failed action deserves full thinking", () => {
    for (const status of ["error", "blocked", "declined", "timeout", "cancelled"]) {
      const messages = [
        user("fix"),
        assistantCalling({ id: "t1", name: "edit" }),
        toolResult("t1", status),
      ];
      expect(classifyStepEffort({ turnIdx: 3, messages }), status).toBe("standard");
    }
  });

  it("stays standard when a result carries no status at all (ambiguous)", () => {
    const messages = [user("x"), assistantCalling({ id: "t1", name: "read" }), toolResult("t1")];
    expect(classifyStepEffort({ turnIdx: 1, messages })).toBe("standard");
  });

  it("turn 0 is always standard — the planning step keeps its full budget", () => {
    const messages = [
      user("x"),
      assistantCalling({ id: "t1", name: "read" }),
      toolResult("t1", "ok"),
    ];
    expect(classifyStepEffort({ turnIdx: 0, messages })).toBe("standard");
  });

  it("kill switch LAX_STEP_EFFORT=off forces standard", () => {
    process.env.LAX_STEP_EFFORT = "off";
    const messages = [
      user("x"),
      assistantCalling({ id: "t1", name: "read" }),
      toolResult("t1", "ok"),
    ];
    expect(classifyStepEffort({ turnIdx: 2, messages })).toBe("standard");
  });

  it("a pending redirect forces standard even over a mechanical batch — the re-plan step keeps its full budget", () => {
    // The redirect is a NEW USER INSTRUCTION appended to the outgoing request
    // OUTSIDE `messages` (canonical-to-chat-param.ts / canonical-to-transport.ts),
    // so the trailing-batch rule alone would misclassify this step.
    const messages = [
      user("fix the bug"),
      assistantCalling({ id: "t1", name: "read" }),
      toolResult("t1", "ok"),
    ];
    expect(classifyStepEffort({ turnIdx: 2, messages })).toBe("mechanical"); // baseline
    expect(classifyStepEffort({
      turnIdx: 2,
      messages,
      pendingRedirect: { instructionId: "ri-1", text: "stop — do X instead", receivedAt: "2026-07-27T10:00:00.000Z" },
    })).toBe("standard");
  });

  it("no trailing tool_result batch → standard", () => {
    expect(classifyStepEffort({ turnIdx: 2, messages: [user("hello")] })).toBe("standard");
  });

  it("unmappable toolCallId (no matching call on the preceding assistant row) → standard", () => {
    const messages = [
      user("x"),
      assistantCalling({ id: "t1", name: "read" }),
      toolResult("OTHER", "ok"),
    ];
    expect(classifyStepEffort({ turnIdx: 2, messages })).toBe("standard");
  });

  it("trailing tool_result with no preceding assistant row → standard", () => {
    expect(classifyStepEffort({ turnIdx: 2, messages: [toolResult("t1", "ok")] })).toBe("standard");
  });

  it("MECHANICAL_TOOLS carries exactly the verified file-mechanics names", () => {
    expect([...MECHANICAL_TOOLS].sort()).toEqual([
      "edit", "edit_lines", "glob", "grep", "multi_edit", "read", "structural_search", "write",
    ]);
  });
});

describe("resolveStepReasoningEffort", () => {
  it("caps mechanical steps at low", () => {
    expect(resolveStepReasoningEffort("mechanical", "high")).toBe("low");
    expect(resolveStepReasoningEffort("mechanical", "xhigh")).toBe("low");
    expect(resolveStepReasoningEffort("mechanical", "medium")).toBe("low");
  });

  it("never up-shifts — a session below the ceiling passes through", () => {
    expect(resolveStepReasoningEffort("mechanical", "minimal")).toBe("minimal");
    expect(resolveStepReasoningEffort("mechanical", "low")).toBe("low");
  });

  it("mechanical with no configured session effort caps the default (medium) to low", () => {
    expect(resolveStepReasoningEffort("mechanical", undefined)).toBe("low");
  });

  it("standard (absent hint) passes the session effort through untouched", () => {
    expect(resolveStepReasoningEffort(undefined, "high")).toBe("high");
    expect(resolveStepReasoningEffort(undefined, undefined)).toBeUndefined();
  });

  it("adapter-specific ceiling: mechanical caps at the passed ceiling instead of the low default", () => {
    expect(resolveStepReasoningEffort("mechanical", "high", "medium")).toBe("medium");
    expect(resolveStepReasoningEffort("mechanical", "xhigh", "medium")).toBe("medium");
    expect(resolveStepReasoningEffort("mechanical", undefined, "medium")).toBe("medium");
  });

  it("adapter-specific ceiling never up-shifts either", () => {
    expect(resolveStepReasoningEffort("mechanical", "low", "medium")).toBe("low");
    expect(resolveStepReasoningEffort("mechanical", "minimal", "medium")).toBe("minimal");
  });
});
