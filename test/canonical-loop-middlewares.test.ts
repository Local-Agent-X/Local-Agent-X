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
import { newOpId } from "../src/ops/op-store.js";
import { appendOpMessage } from "../src/canonical-loop/store.js";
import { _resetMiddlewareStates } from "../src/canonical-loop/middlewares/state.js";
import { _resetEvidenceHistories } from "../src/canonical-loop/middlewares/evidence-history.js";

import { loopDetectionMiddleware } from "../src/canonical-loop/middlewares/loop-detection.js";
import { deadEndMiddleware } from "../src/canonical-loop/middlewares/dead-end.js";
import { postCommitMiddleware } from "../src/canonical-loop/middlewares/post-commit.js";
import { hallucinationCheckMiddleware } from "../src/canonical-loop/middlewares/hallucination-check.js";
import { actionClaimMiddleware } from "../src/canonical-loop/middlewares/action-claim.js";
import { selfCheckMiddleware } from "../src/canonical-loop/middlewares/self-check.js";
import { midTurnStaleMiddleware } from "../src/canonical-loop/middlewares/mid-turn-stale.js";
import { postTurnDetectorMiddleware } from "../src/canonical-loop/middlewares/post-turn-detector.js";
import { forceToolUseMiddleware } from "../src/canonical-loop/middlewares/force-tool-use.js";
import { autoBuildAppMiddleware } from "../src/canonical-loop/middlewares/auto-build-app.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];

// The claim-verify LLM call would hit a real provider; stub it so tests
// stay offline. `null` means "LLM unavailable" → middleware falls back to
// the regex verdict (fires the nudge). `false` means "veto" → no nudge.
// `true` means "confirm" → fire the nudge. Each test that depends on this
// sets it via the mock module override below.
vi.mock("../src/classifiers/claim-verify.js", () => ({
  verifyClaimHallucinationWithLLM: vi.fn(async () => null),
}));
import { verifyClaimHallucinationWithLLM } from "../src/classifiers/claim-verify.js";
const verifyMock = vi.mocked(verifyClaimHallucinationWithLLM);

function mkOp(label: string, type: string = "chat_turn"): Op {
  const id = newOpId(`mw_${label}`);
  tracked.push(id);
  return {
    id,
    type,
    task: `mw ${label}`,
    contextPack: { preferredProvider: "anthropic" } as Op["contextPack"],
    lane: "interactive",
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
  committingToolsThisOp?: string[];
  tools?: ToolDescriptor[];
  evidenceHistory?: number[];
}): CanonicalLoopContext {
  return {
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
    evidenceHistory: args.evidenceHistory ?? [],
  };
}

function mkToolCall(tool: string, args: unknown = {}): ToolCall {
  return { toolCallId: `c${randomUUID().slice(0, 6)}`, tool, args };
}

beforeEach(() => {
  _resetMiddlewareStates();
  _resetEvidenceHistories();
  verifyMock.mockReset();
  verifyMock.mockResolvedValue(null); // default: LLM unavailable → fall back to regex
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

  it("aborts after 3 identical tool calls (exact repeat, strong model)", async () => {
    const op = mkOp("loop-abort");
    const tc = mkToolCall("read", { path: "x" });
    // call once
    let r = await loopDetectionMiddleware.afterModelCall!(mkCtx({ op, toolCalls: [tc] }));
    expect(r.kind).toBe("continue");
    // call again — same key
    r = await loopDetectionMiddleware.afterModelCall!(mkCtx({ op, toolCalls: [tc] }));
    expect(r.kind).toBe("continue");
    // third identical call → abort
    r = await loopDetectionMiddleware.afterModelCall!(mkCtx({ op, toolCalls: [tc] }));
    expect(r.kind).toBe("abort");
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

// ── post-commit ──────────────────────────────────────────────────────────

describe("post-commit middleware", () => {
  it("does not fire on a fresh commit; nudges on the NEXT turn", () => {
    const op = mkOp("post-commit");
    // First turn: see a commit
    const ctx1 = mkCtx({
      op,
      toolResults: [{
        toolName: "bash", toolCallId: "c1",
        content: "[main abc1234] commit msg\n 1 file changed",
      }],
    });
    const r1 = postCommitMiddleware.afterToolExecution!(ctx1);
    expect((r1 as { kind: string }).kind).toBe("continue");
    // Next turn: no commit this round, but flag was set — nudge fires.
    const ctx2 = mkCtx({
      op,
      toolResults: [{ toolName: "bash", toolCallId: "c2", content: "ok" }],
    });
    const r2 = postCommitMiddleware.afterToolExecution!(ctx2);
    expect((r2 as { kind: string }).kind).toBe("nudge");
  });
});

// ── hallucination-check ──────────────────────────────────────────────────

describe("hallucination-check middleware", () => {
  it("ignores turns with tool calls", async () => {
    const op = mkOp("hall-tools");
    const r = await hallucinationCheckMiddleware.afterModelCall!(mkCtx({
      op, toolCalls: [mkToolCall("bash")], assistantContent: "I will save it",
    }));
    expect(r.kind).toBe("continue");
  });

  it("nudges on approval-hallucination text", async () => {
    const op = mkOp("hall-approval");
    const r = await hallucinationCheckMiddleware.afterModelCall!(mkCtx({
      op, assistantContent: "This requires approval before I can proceed.",
    }));
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("approval-hallucination");
  });

  it("nudges on creation-hallucination text on turn 0", async () => {
    verifyMock.mockResolvedValue(true); // LLM confirms
    const op = mkOp("hall-creation");
    const r = await hallucinationCheckMiddleware.afterModelCall!(mkCtx({
      op, turnIdx: 0, assistantContent: "I added the X to your settings.",
    }));
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("creation-hallucination");
  });

  it("skips creation-hallucination on turn > 0", async () => {
    const op = mkOp("hall-no-creation-late");
    const r = await hallucinationCheckMiddleware.afterModelCall!(mkCtx({
      op, turnIdx: 1, assistantContent: "I added the X to your settings.",
    }));
    expect(r.kind).toBe("continue");
  });
});

// ── action-claim ─────────────────────────────────────────────────────────

describe("action-claim middleware", () => {
  it("fires when the model claims an action without calling the matching tool", async () => {
    verifyMock.mockResolvedValue(true);
    const op = mkOp("action-claim-fires");
    const r = await actionClaimMiddleware.afterModelCall!(mkCtx({
      op,
      assistantContent: "I removed the cron job for you.",
      toolsCalledThisOp: ["read", "grep"],
    }));
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("action-claim");
  });

  it("fires at most once per op", async () => {
    verifyMock.mockResolvedValue(true);
    const op = mkOp("action-claim-once");
    const ctxA = mkCtx({
      op, assistantContent: "I deleted the file.",
      toolsCalledThisOp: ["read"],
    });
    const r1 = await actionClaimMiddleware.afterModelCall!(ctxA);
    expect(r1.kind).toBe("nudge");
    const r2 = await actionClaimMiddleware.afterModelCall!(ctxA);
    expect(r2.kind).toBe("continue");
  });

  it("LLM veto suppresses the nudge", async () => {
    verifyMock.mockResolvedValue(false);
    const op = mkOp("action-claim-veto");
    const r = await actionClaimMiddleware.afterModelCall!(mkCtx({
      op, assistantContent: "I noted in the bash output that X failed.",
      toolsCalledThisOp: ["read"],
    }));
    expect(r.kind).toBe("continue");
  });
});

// ── self-check ───────────────────────────────────────────────────────────

describe("self-check middleware", () => {
  it("fires when a tool error appears but the assistant text doesn't acknowledge it", () => {
    const op = mkOp("self-check-fires");
    // Seed op_messages: user, tool error, then assistant continues without acknowledgment.
    appendOpMessage({
      messageId: "u-0", opId: op.id, turnIdx: 0, seqInTurn: 0,
      role: "user", content: { text: "do the thing" },
      createdAt: new Date().toISOString(),
    });
    appendOpMessage({
      messageId: "t-0", opId: op.id, turnIdx: 0, seqInTurn: 1,
      role: "tool_result", content: { text: "BLOCKED: permission denied", toolCallId: "c1" },
      createdAt: new Date().toISOString(),
    });
    const r = selfCheckMiddleware.afterModelCall!(mkCtx({
      op, assistantContent: "All set, here you go.",
    }));
    expect((r as { kind: string }).kind).toBe("nudge");
  });

  it("does not fire when there are no unresolved errors", () => {
    const op = mkOp("self-check-clean");
    appendOpMessage({
      messageId: "u-0", opId: op.id, turnIdx: 0, seqInTurn: 0,
      role: "user", content: { text: "hi" },
      createdAt: new Date().toISOString(),
    });
    const r = selfCheckMiddleware.afterModelCall!(mkCtx({
      op, assistantContent: "Hi there.",
    }));
    expect((r as { kind: string }).kind).toBe("continue");
  });
});

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
      committingToolsThisOp: ["write"],
    }));
    expect((r as { kind: string }).kind).toBe("continue");
  });

  it("first strike nudges; second strike aborts", () => {
    const op = mkOp("stale-strikes");
    // first strike
    const r1 = midTurnStaleMiddleware.beforeTurn!(mkCtx({
      op, turnIdx: 6, evidenceHistory: [3, 3, 3],
    }));
    expect((r1 as { kind: string }).kind).toBe("nudge");
    // second strike: state already remembers nudged → abort
    const r2 = midTurnStaleMiddleware.beforeTurn!(mkCtx({
      op, turnIdx: 7, evidenceHistory: [3, 3, 3],
    }));
    expect((r2 as { kind: string }).kind).toBe("abort");
  });
});

// ── post-turn-detector ───────────────────────────────────────────────────

describe("post-turn-detector middleware", () => {
  it("fires planning-only on iter 0 when the model promises future action but emits no tool calls", async () => {
    const op = mkOp("ptd-planning");
    // seed minimal user message so userMessageHasImages == false
    appendOpMessage({
      messageId: "u-0", opId: op.id, turnIdx: 0, seqInTurn: 0,
      role: "user", content: { text: "build me X" },
      createdAt: new Date().toISOString(),
    });
    const r = await postTurnDetectorMiddleware.afterModelCall!(mkCtx({
      op, turnIdx: 0,
      assistantContent: "I'll create that file for you. Let me start by writing the structure.",
    }));
    // planning-only should fire
    expect((r as { kind: string }).kind).toBe("nudge");
    expect((r as { reason: string }).reason).toMatch(/^post-turn:/);
  });

  it("returns continue on a clean assistant reply", async () => {
    const op = mkOp("ptd-clean");
    appendOpMessage({
      messageId: "u-0", opId: op.id, turnIdx: 0, seqInTurn: 0,
      role: "user", content: { text: "what's 2+2?" },
      createdAt: new Date().toISOString(),
    });
    const r = await postTurnDetectorMiddleware.afterModelCall!(mkCtx({
      op, turnIdx: 0, assistantContent: "4.",
    }));
    expect((r as { kind: string }).kind).toBe("continue");
  });
});

// ── force-tool-use ───────────────────────────────────────────────────────

describe("force-tool-use middleware", () => {
  it("only registers for codex provider", () => {
    expect(forceToolUseMiddleware.when?.(mkCtx({ op: mkOp("ftu-c"), provider: "codex" }))).toBe(true);
    expect(forceToolUseMiddleware.when?.(mkCtx({ op: mkOp("ftu-a"), provider: "anthropic" }))).toBe(false);
  });

  it("sets toolChoice=required on turn 0 for build intents", () => {
    const op = mkOp("ftu-build");
    forceToolUseMiddleware.beforeTurn!(mkCtx({
      op, turnIdx: 0, provider: "codex", userMessage: "build me an app",
    }));
    expect((op.canonical as { toolChoice?: string })?.toolChoice).toBe("required");
  });

  it("resets to auto on turn > 0", () => {
    const op = mkOp("ftu-reset");
    op.canonical = { toolChoice: "required" } as typeof op.canonical;
    forceToolUseMiddleware.beforeTurn!(mkCtx({
      op, turnIdx: 1, provider: "codex", userMessage: "build me an app",
    }));
    expect((op.canonical as { toolChoice?: string })?.toolChoice).toBe("auto");
  });
});

// ── auto-build-app ───────────────────────────────────────────────────────

describe("auto-build-app middleware", () => {
  it("only registers for anthropic provider", () => {
    expect(autoBuildAppMiddleware.when?.(mkCtx({ op: mkOp("aba-a"), provider: "anthropic" }))).toBe(true);
    expect(autoBuildAppMiddleware.when?.(mkCtx({ op: mkOp("aba-c"), provider: "codex" }))).toBe(false);
  });

  it("does nothing when the model already emitted tool calls", () => {
    const op = mkOp("aba-tools");
    const ctx = mkCtx({
      op, provider: "anthropic",
      userMessage: "build me a calendar app",
      assistantContent: "Building it now",
      toolCalls: [mkToolCall("build_app")],
      tools: [{ name: "build_app" }],
    });
    autoBuildAppMiddleware.afterModelCall!(ctx);
    expect(ctx.toolCalls).toHaveLength(1);
  });

  it("does nothing when build_app is not available in the tool surface", () => {
    const op = mkOp("aba-no-tool");
    const ctx = mkCtx({
      op, provider: "anthropic",
      userMessage: "build me a calendar app",
      assistantContent: "Sure, building a calendar app for you now.",
      tools: [],
    });
    autoBuildAppMiddleware.afterModelCall!(ctx);
    expect(ctx.toolCalls).toHaveLength(0);
  });

  it("synthesizes a build_app tool call on detected build intent", () => {
    const op = mkOp("aba-fires");
    const ctx = mkCtx({
      op, provider: "anthropic",
      userMessage: "build me a calendar app",
      // claudeCodeSignals regex requires explicit "I'll write the files" /
      // "I'll create the files" commitment shape — that's what flags an
      // Anthropic answer as a build commitment vs a clarifying question.
      assistantContent: "I'll write the files for the calendar app now.",
      tools: [{ name: "build_app" }],
    });
    autoBuildAppMiddleware.afterModelCall!(ctx);
    expect(ctx.toolCalls).toHaveLength(1);
    expect(ctx.toolCalls[0].tool).toBe("build_app");
  });
});
