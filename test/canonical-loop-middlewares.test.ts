/**
 * P4.C2 — per-middleware unit tests for the canonical-loop safety stack.
 *
 * Mirrors the agent-loop middleware test layout where applicable. Each
 * suite hits one middleware in isolation: build a CanonicalLoopContext,
 * call the middleware's hook directly, assert the verdict.
 *
 * The cross-middleware "host" wiring (phase short-circuit, nudge-as-user
 * message append, abort → terminal=error) is exercised by the existing
 * canonical-loop integration tests — these tests stay focused on per-
 * middleware decision logic so a regression points at one file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Op } from "../src/ops/types.js";
import type { CanonicalLoopContext, CanonicalToolResultView } from "../src/canonical-loop/middlewares/types.js";
import type { ToolCall, ToolDescriptor } from "../src/canonical-loop/contract-types.js";
import { newOpId, writeOp } from "../src/ops/op-store.js";
import { appendOpMessage, insertOpTurn } from "../src/canonical-loop/store.js";
import { buildCanonicalLoopContext } from "../src/canonical-loop/middlewares/host.js";
import { _resetMiddlewareStates } from "../src/canonical-loop/middlewares/state.js";
import { _resetEvidenceHistories } from "../src/canonical-loop/middlewares/evidence-history.js";
import { makeCanonicalLoopContext } from "../src/canonical-loop/middlewares/ctx.test-helper.js";

import { loopDetectionMiddleware } from "../src/canonical-loop/middlewares/loop-detection.js";
import { deadEndMiddleware } from "../src/canonical-loop/middlewares/dead-end.js";
import { prematureCompletionMiddleware } from "../src/canonical-loop/middlewares/premature-completion.js";
import { midTurnStaleMiddleware } from "../src/canonical-loop/middlewares/mid-turn-stale.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];

function mkOp(label: string, type: string = "chat_turn", lane: Op["lane"] = "interactive"): Op {
  const id = newOpId(`mw_${label}`);
  tracked.push(id);
  return {
    id,
    type,
    task: `mw ${label}`,
    contextPack: { preferredProvider: "anthropic" } as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-mw",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

function mkCtx(args: {
  op: Op;
  turnIdx?: number;
  provider?: string;
  model?: string;
  userMessage?: string;
  assistantContent?: string;
  toolCalls?: ToolCall[];
  toolResults?: CanonicalToolResultView[];
  toolsCalledThisOp?: string[];
  // The two committing tallies are separate knobs on purpose: each test sets
  // the one the middleware under test actually reads (raw name-only or
  // substantive — see middlewares/types.ts).
  committingToolsThisOp?: string[];
  substantiveCommittingToolsThisOp?: string[];
  tools?: ToolDescriptor[];
  evidenceHistory?: number[];
}): CanonicalLoopContext {
  // Through the shared factory (src/canonical-loop/middlewares/ctx.test-helper.ts)
  // so a newly required ctx field arrives here with a default instead of
  // reaching a middleware as `undefined`. Files under test/ are outside
  // tsconfig's `include: ["src"]`, so tsc never checked this literal at all —
  // it was fully typed and STILL two fields short.
  return makeCanonicalLoopContext({
    op: args.op,
    turnIdx: args.turnIdx ?? 0,
    userMessage: args.userMessage ?? "",
    provider: args.provider ?? "anthropic",
    model: args.model ?? "claude-sonnet-4-6",
    tools: args.tools ?? [],
    toolNames: new Set((args.tools ?? []).map(t => t.name)),
    assistantContent: args.assistantContent ?? "",
    toolCalls: args.toolCalls ?? [],
    toolResults: args.toolResults ?? [],
    toolsCalledThisOp: new Set(args.toolsCalledThisOp ?? []),
    committingToolsThisOp: new Set(args.committingToolsThisOp ?? []),
    substantiveCommittingToolsThisOp: new Set(args.substantiveCommittingToolsThisOp ?? []),
    evidenceHistory: args.evidenceHistory ?? [],
  });
}

function mkToolCall(tool: string, args: unknown = {}): ToolCall {
  return { toolCallId: `c${randomUUID().slice(0, 6)}`, tool, args };
}

beforeEach(() => {
  _resetMiddlewareStates();
  _resetEvidenceHistories();
});

afterEach(() => {
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
});

// ── loop-detection ───────────────────────────────────────────────────────

describe("loop-detection middleware", () => {
  it("returns continue when no tool calls were emitted", async () => {
    const op = mkOp("loop-no-tools");
    const ctx = mkCtx({ op });
    const r = await loopDetectionMiddleware.afterModelCall!(ctx);
    expect(r.kind).toBe("continue");
  });

  it("autonomously pivots repeated identical worker calls with the SAME result", async () => {
    const op = mkOp("loop-abort", "chat_turn", "background");
    const tc = mkToolCall("read", { path: "x" });
    const sameResult: CanonicalToolResultView[] = [{ toolName: "read", toolCallId: tc.toolCallId, content: "unchanged output" }];
    const turn = async () => {
      const verdict = await loopDetectionMiddleware.afterModelCall!(mkCtx({ op, toolCalls: [tc] }));
      const completed = await loopDetectionMiddleware.afterToolExecution!(mkCtx({ op, toolCalls: [tc], toolResults: sameResult }));
      return { beforeDispatch: verdict, completed };
    };
    expect((await turn()).beforeDispatch.kind).toBe("continue");
    expect((await turn()).beforeDispatch.kind).toBe("continue");
    const pivot = await turn();
    expect(pivot.beforeDispatch.kind).toBe("continue");
    expect(pivot.completed.kind).toBe("nudge");
    expect((pivot.completed as { reason: string }).reason).toBe("strategy-pivot");
  });

  it("does NOT abort repeated identical calls whose RESULT changes each time (user-requested repetition / polling)", async () => {
    const op = mkOp("loop-progress");
    const tc = mkToolCall("bash", { command: "sleep 1 && date" });
    const turn = async (i: number) => {
      const verdict = await loopDetectionMiddleware.afterModelCall!(mkCtx({ op, toolCalls: [tc] }));
      const result: CanonicalToolResultView[] = [{ toolName: "bash", toolCallId: tc.toolCallId, content: `timestamp ${i}` }];
      await loopDetectionMiddleware.afterToolExecution!(mkCtx({ op, toolCalls: [tc], toolResults: result }));
      return verdict;
    };
    for (let i = 0; i < 6; i++) {
      expect((await turn(i)).kind).toBe("continue");
    }
  });
});

// ── dead-end ─────────────────────────────────────────────────────────────

describe("dead-end middleware", () => {
  it("returns continue on first empty tool result", () => {
    const op = mkOp("dead-end-first");
    const ctx = mkCtx({
      op,
      toolResults: [{ toolName: "grep", toolCallId: "c1", content: "" }],
    });
    const r = deadEndMiddleware.afterToolExecution!(ctx);
    expect((r as { kind: string }).kind).toBe("continue");
  });

  it("nudges after 3 consecutive empty results", () => {
    const op = mkOp("dead-end-third");
    for (let i = 0; i < 2; i++) {
      const r = deadEndMiddleware.afterToolExecution!(mkCtx({
        op,
        toolResults: [{ toolName: "grep", toolCallId: `c${i}`, content: "" }],
      }));
      expect((r as { kind: string }).kind).toBe("continue");
    }
    const r = deadEndMiddleware.afterToolExecution!(mkCtx({
      op,
      toolResults: [{ toolName: "grep", toolCallId: "c3", content: "" }],
    }));
    expect((r as { kind: string }).kind).toBe("nudge");
  });
});


// ── action-claim ─────────────────────────────────────────────────────────

// ── premature-completion ─────────────────────────────────────────────────

describe("premature-completion middleware", () => {
  it("when() exempts interactive ops (chat + voice), applies to worker ops", () => {
    expect(prematureCompletionMiddleware.when?.(mkCtx({ op: mkOp("pc-chat", "chat_turn", "interactive") }))).toBe(false);
    expect(prematureCompletionMiddleware.when?.(mkCtx({ op: mkOp("pc-voice", "voice_turn", "interactive") }))).toBe(false);
    expect(prematureCompletionMiddleware.when?.(mkCtx({ op: mkOp("pc-work", "research", "agent") }))).toBe(true);
  });

  it("nudges a worker op that ends tool-lessly with nothing committed", async () => {
    const op = mkOp("pc-fires", "research");
    const r = await prematureCompletionMiddleware.afterModelCall!(mkCtx({
      op,
      userMessage: "summarize the repo architecture into a doc",
      assistantContent: "Here is a summary of the architecture. Done.",
    }));
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("premature-completion");
  });

  it("continues when a committing tool already ran this op", async () => {
    const op = mkOp("pc-committed", "research");
    const r = await prematureCompletionMiddleware.afterModelCall!(mkCtx({
      op,
      assistantContent: "All set, the report is written.",
      // The completion-gate tally — this guard asks "did the op do work on the
      // USER'S request?", not the "any side effect on record" question.
      substantiveCommittingToolsThisOp: ["write"],
    }));
    expect(r.kind).toBe("continue");
  });

  it("continues when the turn made tool calls", async () => {
    const op = mkOp("pc-tools", "research");
    const r = await prematureCompletionMiddleware.afterModelCall!(mkCtx({
      op,
      assistantContent: "Writing it now.",
      toolCalls: [mkToolCall("write")],
    }));
    expect(r.kind).toBe("continue");
  });

  it("continues on an empty assistant turn", async () => {
    const op = mkOp("pc-empty", "research");
    const r = await prematureCompletionMiddleware.afterModelCall!(mkCtx({
      op, assistantContent: "   ",
    }));
    expect(r.kind).toBe("continue");
  });

  it("fires at most once per op", async () => {
    const op = mkOp("pc-once", "research");
    const ctx = mkCtx({
      op,
      userMessage: "do the task",
      assistantContent: "I think that covers it.",
    });
    const r1 = await prematureCompletionMiddleware.afterModelCall!(ctx);
    expect(r1.kind).toBe("nudge");
    const r2 = await prematureCompletionMiddleware.afterModelCall!(ctx);
    expect(r2.kind).toBe("continue");
  });
});

// ── self-check ───────────────────────────────────────────────────────────

// ── mid-turn-stale ───────────────────────────────────────────────────────

describe("mid-turn-stale middleware", () => {
  it("does not fire before turn 5", () => {
    const op = mkOp("stale-early");
    const r = midTurnStaleMiddleware.beforeTurn!(mkCtx({
      op, turnIdx: 3, evidenceHistory: [1, 1, 1],
    }));
    expect((r as { kind: string }).kind).toBe("continue");
  });

  it("does not fire if a committing tool has run this op", () => {
    const op = mkOp("stale-with-commit");
    const r = midTurnStaleMiddleware.beforeTurn!(mkCtx({
      op, turnIdx: 6, evidenceHistory: [1, 1, 1],
      // The raw name-only tally — this brake asks "is there a side effect on
      // record I'd be aborting on top of?".
      committingToolsThisOp: ["write"],
    }));
    expect((r as { kind: string }).kind).toBe("continue");
  });

  it("worker op: every flat-evidence strike continues through an autonomous pivot", () => {
    const op = mkOp("stale-worker", "agent_turn", "agent");
    const r1 = midTurnStaleMiddleware.beforeTurn!(mkCtx({
      op, turnIdx: 6, evidenceHistory: [3, 3, 3],
    }));
    expect((r1 as { kind: string }).kind).toBe("nudge");
    const r2 = midTurnStaleMiddleware.beforeTurn!(mkCtx({
      op, turnIdx: 7, evidenceHistory: [3, 3, 3],
    }));
    expect((r2 as { kind: string }).kind).toBe("nudge");
    expect((r2 as { reason: string }).reason).toBe("strategy-pivot");
  });

  it("interactive op: first strike is silent (no leaked nudge) but the circuit-breaker still aborts", () => {
    const op = mkOp("stale-interactive");
    const r1 = midTurnStaleMiddleware.beforeTurn!(mkCtx({
      op, turnIdx: 6, evidenceHistory: [3, 3, 3],
    }));
    expect((r1 as { kind: string }).kind).toBe("continue");
    const r2 = midTurnStaleMiddleware.beforeTurn!(mkCtx({
      op, turnIdx: 7, evidenceHistory: [3, 3, 3],
    }));
    expect((r2 as { kind: string }).kind).toBe("abort");
  });
});

// ── post-turn-detector ───────────────────────────────────────────────────


// ── host: toolsCalledThisOp success-only semantics ──────────────────────

describe("buildCanonicalLoopContext — toolsCalledThisOp", () => {
  function commitTurn(op: Op, turnIdx: number, summary: Array<{ tool: string; resultStatus: "ok" | "error" | "blocked" | "declined" | "timeout" | "cancelled" }>): void {
    insertOpTurn({
      opId: op.id,
      turnIdx,
      providerState: { kind: "anthropic", state: {} as never },
      toolCallSummary: summary.map(s => ({
        tool: s.tool,
        argsHash: "deadbeef00000000",
        resultStatus: s.resultStatus,
        durationMs: 1,
      })),
      terminalReason: "done",
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    });
  }

  it("includes tools with resultStatus=ok, excludes error/cancelled", () => {
    const op = mkOp("host-success-only");
    writeOp(op);
    commitTurn(op, 0, [
      { tool: "read", resultStatus: "ok" },
      { tool: "agent_spawn", resultStatus: "error" },     // failed spawn — must NOT count
      { tool: "bash", resultStatus: "cancelled" },        // cancelled — must NOT count
      { tool: "browser", resultStatus: "blocked" },       // widened flavor — must NOT count
      { tool: "http_request", resultStatus: "timeout" },  // widened flavor — must NOT count
      { tool: "write", resultStatus: "ok" },
    ]);

    const ctx = buildCanonicalLoopContext({ op, turnIdx: 1, evidenceHistory: [] });
    expect([...ctx.toolsCalledThisOp].sort()).toEqual(["read", "write"]);
    expect(ctx.toolsCalledThisOp.has("agent_spawn")).toBe(false);
    expect(ctx.toolsCalledThisOp.has("bash")).toBe(false);
  });

  it("aggregates across multiple turns", () => {
    const op = mkOp("host-multi-turn");
    writeOp(op);
    commitTurn(op, 0, [{ tool: "read", resultStatus: "ok" }]);
    commitTurn(op, 1, [{ tool: "edit", resultStatus: "ok" }]);
    commitTurn(op, 2, [{ tool: "agent_spawn", resultStatus: "error" }]);

    const ctx = buildCanonicalLoopContext({ op, turnIdx: 3, evidenceHistory: [] });
    expect([...ctx.toolsCalledThisOp].sort()).toEqual(["edit", "read"]);
  });
});
