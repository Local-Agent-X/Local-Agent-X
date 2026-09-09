/**
 * `ctx.currentUserMessage` on a slash-command op must be what the user
 * AUTHORED, not the expanded template.
 *
 * On the chat path op.task is stamped AFTER expandSlash (routes/chat/
 * run-chat-turn/orchestrator.ts → chat-runner/create-op.ts), so it carries the
 * **SLASH COMMAND** wrapper plus the whole SKILL.md body. Every gate reads
 * currentUserMessage, and the templates trip them on their own words: a bare
 * mid-session `/senior-engineer` acked with zero tool calls made
 * broad-sweep-nudge fire "Stop — this is a codebase-wide change…" and
 * cleanup-verify stamp the op unverified. The gates must see the ask.
 *
 * Built through buildCanonicalLoopContext the way production does (see
 * current-user-message.test.ts), then the three regex gates are asserted
 * directly against the field the context exposes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store.js", () => ({
  readOpTurns: vi.fn(() => []),
  readOpMessages: vi.fn(() => []),
}));
vi.mock("../op-model.js", () => ({ resolveOpModel: vi.fn(() => "test-model") }));
// office-theme-guard records its arg rewrite as a guard fire (guard-fire.ts);
// this file asserts the REGEX gates, not telemetry, and its store is a stub.
vi.mock("../event-emitter.js", () => ({ emit: vi.fn() }));

import { buildCanonicalLoopContext } from "./host.js";
import { readOpMessages } from "../store.js";
import { clearMiddlewareStateForOp } from "./state.js";
import { looksLikeBroadSweep } from "./broad-sweep-nudge.js";
import { officeThemeGuardMiddleware } from "./office-theme-guard.js";
import { looksLikeCleanupSweep } from "../../agent-guards/cleanup-verify.js";
import { expandSlashCommand, userAuthoredRequest } from "../../slash-commands.js";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";

const mockMessages = vi.mocked(readOpMessages);
const OP_ID = "op-current-user-message-slash";

const BARE = expandSlashCommand("/senior-engineer")!.agentMessage;
const WITH_ARG = expandSlashCommand("/vibe-code fix the login bug")!.agentMessage;

function opWithTask(task: string): Op {
  return { id: OP_ID, lane: "interactive", type: "chat_turn", task } as unknown as Op;
}

function ctx(op: Op, toolCalls: ToolCall[] = []) {
  return buildCanonicalLoopContext({ op, turnIdx: 2, evidenceHistory: [], toolCalls });
}

/** Does the office-theme guard treat the message as a look request? It keeps
 *  a `theme` override only when LOOK_REQUEST_RE matches currentUserMessage, so
 *  the surviving arg is the observable. */
async function themeSurvives(op: Op): Promise<boolean> {
  const call = { id: "t1", tool: "presentation", args: { action: "create", theme: "scandal red" } } as unknown as ToolCall;
  const c = ctx(op, [call]);
  const res = await officeThemeGuardMiddleware.afterModelCall!(c);
  expect(res.kind).toBe("continue");
  return "theme" in (call.args as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMessages.mockReturnValue([] as never);
  clearMiddlewareStateForOp(OP_ID);
});

describe("the expansions really are what the gates would misjudge", () => {
  // If a template stops tripping the gates on its own, the assertions below
  // stop proving anything — keep the premise pinned.
  it("raw templates trip broad-sweep, cleanup-sweep and the look regex", () => {
    for (const raw of [BARE, WITH_ARG]) {
      expect(looksLikeBroadSweep(raw)).toBe(true);
      expect(looksLikeCleanupSweep(raw)).toBe(true);
    }
    expect(BARE).not.toBe("/senior-engineer");
    expect(WITH_ARG).toContain("**SLASH COMMAND**");
  });
});

describe("currentUserMessage on a slash-command op", () => {
  it("is the bare `/senior-engineer` the user typed", () => {
    expect(ctx(opWithTask(BARE)).currentUserMessage).toBe("/senior-engineer");
  });

  it("is `/vibe-code fix the login bug` — command plus the user's argument", () => {
    expect(ctx(opWithTask(WITH_ARG)).currentUserMessage).toBe("/vibe-code fix the login bug");
  });

  it("does not read as a broad sweep, a cleanup sweep, or a look request", async () => {
    for (const raw of [BARE, WITH_ARG]) {
      const c = ctx(opWithTask(raw));
      expect(looksLikeBroadSweep(c.currentUserMessage)).toBe(false);
      expect(looksLikeCleanupSweep(c.currentUserMessage)).toBe(false);
      expect(await themeSurvives(opWithTask(raw))).toBe(false);
    }
  });

  it("leaves the stale `userMessage` field as-is (op.task fallback, unrecovered)", () => {
    const c = ctx(opWithTask(WITH_ARG));
    expect(c.userMessage).toBe(WITH_ARG);
    expect(c.userMessage).not.toBe(c.currentUserMessage);
  });

  it("leaves `userMessage` on the session's first user row when history is seeded", () => {
    mockMessages.mockReturnValue([
      { messageId: "m0", opId: OP_ID, turnIdx: 0, seqInTurn: 0, role: "user", content: { text: "Yo" }, createdAt: "" },
      { messageId: "m1", opId: OP_ID, turnIdx: 0, seqInTurn: 1, role: "user", content: { text: WITH_ARG }, createdAt: "" },
    ] as never);
    const c = ctx(opWithTask(WITH_ARG));
    expect(c.userMessage).toBe("Yo");
    expect(c.currentUserMessage).toBe("/vibe-code fix the login bug");
  });
});

describe("plain messages are untouched", () => {
  it("passes through userAuthoredRequest and the context byte-identical", async () => {
    const msg = "tidy up the grey bar above the nav on mobile";
    expect(userAuthoredRequest(msg)).toBe(msg);
    expect(ctx(opWithTask(msg)).currentUserMessage).toBe(msg);
    // …and a real look request still keeps its theme.
    expect(await themeSurvives(opWithTask("make the deck red and bold"))).toBe(true);
  });
});
