import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "./adapter-contract.js";
import type { ToolCall } from "./contract-types.js";
import type { Op } from "../ops/types.js";

// First end-to-end turn test: drive a full op through canonical-loop's PUBLIC
// surface — canonicalLoopEntry → real scheduler → real worker → real turn-loop
// (real middleware host, real commit, real state machine) — with ONLY the two
// injection seams the module exposes swapped for fakes: the per-op adapter
// (registerAdapterForOp) and the tool dispatcher (setToolDispatcher).
//
// Scenario: turn 0 the model requests one tool call; the dispatcher returns a
// canned result; turn 1 the model reads the fed-back result and finishes with
// a final text. The op must land `succeeded` with the four-message transcript
// persisted in order: user seed → assistant tool call → tool result → final
// assistant text.

// ops/event-log.ts and ops/op-store.ts bind OPS_BASE = join(getLaxDir(), …) at
// import, so isolate the data dir to a fresh temp directory BEFORE the dynamic
// import below (top-level await runs at file eval) — nothing touches ~/.lax.
const prevLaxDir = process.env.LAX_DATA_DIR;
const tmp = mkdtempSync(join(tmpdir(), "lax-full-turn-"));
process.env.LAX_DATA_DIR = tmp;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(tmp, { recursive: true, force: true });
});

const {
  canonicalLoopEntry,
  registerAdapterForOp,
  setToolDispatcher,
  functionToolDispatcher,
  awaitCanonicalOp,
  awaitIdle,
  readOpMessages,
  resetCanonicalRuntime,
  resetScheduler,
  opResume,
} = await import("./index.js");
const { readOp } = await import("../ops/op-store.js");
const { setMiddlewareStack, _resetMiddlewareStack } = await import("./middlewares/host.js");
const { repeatFailureMiddleware } = await import("./middlewares/repeat-failure.js");

afterAll(() => {
  resetCanonicalRuntime();
  resetScheduler();
  _resetMiddlewareStack();
});

const TOOL_CALL: ToolCall = {
  toolCallId: "tc-1",
  tool: "widget_lookup",
  args: { widgetId: "w-1" },
};
const FINAL_TEXT = "The widget is blue.";

/** Two-turn scripted adapter: turn 0 → one tool call, turn 1+ → final text. */
function fakeAdapter(): Adapter {
  return {
    name: "fake-full-turn",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      const providerState = { adapterName: "fake-full-turn", adapterVersion: "1", providerPayload: null };
      if (input.turnIdx === 0) {
        report({ kind: "tool_call_requested", call: TOOL_CALL });
        report({
          kind: "message_finalized",
          message: {
            messageId: "am-turn-0",
            role: "assistant",
            content: { text: "", toolCalls: [TOOL_CALL] },
          },
        });
        return { providerState, modelStop: "continue" };
      }
      report({
        kind: "message_finalized",
        message: { messageId: "am-turn-1", role: "assistant", content: { text: FINAL_TEXT } },
      });
      return { providerState, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* nothing in flight — scripted turns */ },
  };
}

function fullTurnOp(): Op {
  const task = "What color is widget w-1?";
  return {
    id: `op-full-turn-${randomUUID().slice(0, 8)}`,
    type: "freeform",
    task,
    contextPack: {
      task: { description: task, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 8, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "interactive" },
      secrets: { allowed: [] },
    },
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "local-user",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    model: "fake-test-model",
  };
}

function resumableBuildAdapter(): Adapter {
  return {
    name: "fake-resumable-build",
    version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      const providerState = { adapterName: "fake-resumable-build", adapterVersion: "1", providerPayload: null };
      if (input.turnIdx < 5) {
        const call: ToolCall = { toolCallId: `shell-${input.turnIdx}`, tool: "bash", args: { command: "npm run build" } };
        report({ kind: "tool_call_requested", call });
        report({
          kind: "message_finalized",
          message: { messageId: `am-shell-${input.turnIdx}`, role: "assistant", content: { text: "", toolCalls: [call] } },
        });
        return { providerState, modelStop: "continue" };
      }
      report({
        kind: "message_finalized",
        message: { messageId: "am-resumed", role: "assistant", content: { text: "Build complete after resume." } },
      });
      return { providerState, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted turns unwind immediately */ },
  };
}

async function waitForState(opId: string, state: string): Promise<Op> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = readOp(opId);
    if (current?.canonical?.state === state) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const current = readOp(opId);
  throw new Error(`op ${opId} did not reach ${state}; current=${current?.canonical?.state}, turn=${current?.canonical?.currentTurnIdx}`);
}

describe("canonical-loop full turn — entry → scheduler → worker → turn-loop → terminal", () => {
  it("drives a tool-call turn plus a wrap-up turn to succeeded with the full transcript persisted", async () => {
    const dispatch = vi.fn(async (_call: ToolCall) => ({
      status: "ok" as const,
      result: { color: "blue" },
    }));
    setToolDispatcher(functionToolDispatcher(dispatch));

    const op = fullTurnOp();
    registerAdapterForOp(op.id, fakeAdapter);
    canonicalLoopEntry(op);

    // (1) Terminal state — a hung scheduler resolves null / throws here, not CI.
    const result = await awaitCanonicalOp(op.id, 10_000);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
    await awaitIdle(5_000);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

    // (2) Persisted transcript: user seed → assistant tool call → tool result
    //     → final assistant text, in append order.
    const rows = readOpMessages(op.id);
    expect(rows.map(r => r.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
    expect((rows[0].content as { text: string }).text).toContain(op.task);
    expect((rows[1].content as { toolCalls: ToolCall[] }).toolCalls).toEqual([TOOL_CALL]);
    expect(rows[2].content).toEqual({
      toolCallId: TOOL_CALL.toolCallId,
      result: { color: "blue" },
      status: "ok",
    });
    expect((rows[3].content as { text: string }).text).toBe(FINAL_TEXT);

    // (3) The dispatcher ran exactly once, with the model's requested call.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(TOOL_CALL);
  }, 15_000);

  it("suspends a blocked build and resumes the same op from its next turn", async () => {
    setMiddlewareStack([repeatFailureMiddleware]);
    setToolDispatcher(functionToolDispatcher(async () => ({
      status: "blocked" as const,
      result: { error: "BLOCKED (unattended): sandbox unavailable" },
    })));

    const op = fullTurnOp();
    op.id = `op-resumable-build-${randomUUID().slice(0, 8)}`;
    op.type = "app_build";
    op.lane = "build";
    op.contextPack.routing.lane = "build";
    registerAdapterForOp(op.id, resumableBuildAdapter);
    canonicalLoopEntry(op);

    const paused = await waitForState(op.id, "paused");
    expect(paused.canonical?.suspension?.reason).toBe("blocked");
    expect(paused.canonical?.currentTurnIdx).toBe(4);

    expect(opResume(op.id, "test")).toEqual({ ok: true });
    const result = await awaitCanonicalOp(op.id, 10_000);
    expect(result?.status).toBe("completed");
    await awaitIdle(5_000);

    const completed = readOp(op.id);
    expect(completed?.canonical?.state).toBe("succeeded");
    expect(completed?.canonical?.suspension).toBeNull();
    expect(completed?.canonical?.currentTurnIdx).toBe(5);
  }, 15_000);
});
