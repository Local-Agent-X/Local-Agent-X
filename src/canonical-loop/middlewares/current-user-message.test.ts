/**
 * `ctx.currentUserMessage` vs `ctx.userMessage`, pinned against a REAL
 * history-seeded op shape rather than a hand-passed string.
 *
 * The bug this exists for: `userMessage` is documented as "the user message
 * that kicked off this op", and it is not. host.ts takes the FIRST user row in
 * op_messages, while chat-runner/seed-messages.ts seeds the ENTIRE prior
 * conversation as user rows and appends the current message LAST. So on every
 * op after a session's opening line, `userMessage` holds an older message.
 * Observed on op_chat_turn_690ce6c3cd1b4394: op.task = "Hi", first user row =
 * "Yo".
 *
 * Every test fixture in this directory passed a message straight into the
 * context factory, so nothing exercised the seam and the bug was invisible.
 * These tests build the context the way production does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store.js", () => ({
  readOpTurns: vi.fn(() => []),
  readOpMessages: vi.fn(() => []),
}));
vi.mock("../op-model.js", () => ({ resolveOpModel: vi.fn(() => "test-model") }));

import { buildCanonicalLoopContext } from "./host.js";
import { readOpMessages } from "../store.js";
import { clearMiddlewareStateForOp } from "./state.js";
import type { Op } from "../../ops/types.js";

const mockMessages = vi.mocked(readOpMessages);

const OP_ID = "op-current-user-message";

function opWithTask(task: string, over: Record<string, unknown> = {}): Op {
  return { id: OP_ID, lane: "interactive", type: "chat_turn", task, ...over } as unknown as Op;
}

/** The exact row ordering chat-runner/seed-messages.ts writes: prior turns
 *  first (user + assistant rows), current user message LAST. */
function seedHistory(rows: Array<{ role: string; text: string; kind?: string }>) {
  mockMessages.mockReturnValue(rows.map((r, i) => ({
    messageId: `m${i}`,
    opId: OP_ID,
    turnIdx: 0,
    seqInTurn: i,
    role: r.role,
    content: r.kind ? { text: r.text, kind: r.kind } : { text: r.text },
    createdAt: "",
  })) as never);
}

function ctx(op: Op) {
  return buildCanonicalLoopContext({ op, turnIdx: 2, evidenceHistory: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMessages.mockReturnValue([] as never);
  clearMiddlewareStateForOp(OP_ID);
});

describe("currentUserMessage", () => {
  it("is the message that opened THIS op, not the session's first message", () => {
    seedHistory([
      { role: "user", text: "Yo" },
      { role: "assistant", text: "Hey!" },
      { role: "user", text: "Hi" },
    ]);
    const c = ctx(opWithTask("Hi"));
    expect(c.currentUserMessage).toBe("Hi");
    // …and the pre-existing field keeps its (stale) meaning on purpose: ten
    // other middlewares read it, and repointing them is a separate change.
    expect(c.userMessage).toBe("Yo");
  });

  it("falls back to op.task when the op has no messages yet", () => {
    expect(ctx(opWithTask("first message of the session")).currentUserMessage)
      .toBe("first message of the session");
  });

  it("is empty, not undefined, when the op carries no task", () => {
    expect(ctx(opWithTask(undefined as unknown as string)).currentUserMessage).toBe("");
  });

  /**
   * Why the source is `op.task` and not "the LAST user row". Middleware nudges
   * (turn-loop/nudges.ts) and mid-turn injects (turn-loop/inject-drain.ts) are
   * both appended with role:"user", so the last user row drifts onto harness
   * text mid-op. op.task is stamped at op creation and never mutates.
   */
  it("does not drift onto a harness nudge appended as a user row", () => {
    seedHistory([
      { role: "user", text: "Yo" },
      { role: "user", text: "there is a grey bar above the nav bar on mobile" },
      { role: "user", text: "SYSTEM: settle one question before continuing", kind: "nudge" },
    ]);
    expect(ctx(opWithTask("there is a grey bar above the nav bar on mobile")).currentUserMessage)
      .toBe("there is a grey bar above the nav bar on mobile");
  });
});

