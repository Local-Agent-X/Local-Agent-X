import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import type { OpMessageRow } from "../types.js";

// The middleware dynamically imports "../store.js" for readOpMessages. Mock it
// so we drive op_messages without touching disk. readOpTurns is unused by this
// middleware but exported from the same module, so stub it to keep the shape.
let mockRows: OpMessageRow[] = [];
vi.mock("../store.js", () => ({
  readOpMessages: vi.fn(() => mockRows),
  readOpTurns: vi.fn(() => []),
}));

import { postTurnDetectorMiddleware } from "./post-turn-detector.js";
import { _resetMiddlewareStates } from "./state.js";

function row(role: OpMessageRow["role"], content: unknown): OpMessageRow {
  return { messageId: "m", opId: "o", turnIdx: 0, seqInTurn: 0, role, content, createdAt: "" };
}

let opCounter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `op-ptd-${opCounter++}`, lane: "agent" },
    turnIdx: 4,
    toolCalls: [],
    toolsCalledThisOp: new Set<string>(),
    evidenceHistory: [],
    // Vision reply: "I see X, try Y". Regex-reads as a stalled plan
    // ("I'll fix ... next") → planning-only fires UNLESS the image exemption
    // engages.
    assistantContent: "I can see the login button overlaps the header. I'll fix the layout next.",
    ...over,
  } as unknown as CanonicalLoopContext;
}

async function fire(c: CanonicalLoopContext) {
  return postTurnDetectorMiddleware.afterModelCall!(c);
}

describe("post-turn-detector — image exemption (HE-1)", () => {
  beforeEach(() => {
    _resetMiddlewareStates();
    mockRows = [];
  });

  it("skips the planning-only nudge when the latest user turn carried an image", async () => {
    // Canonical image envelope: `{ text, images: [...] }` — NOT a multi-part
    // image_url array. Pre-fix code stripped this to content:"" and the
    // detector fired a nudge.
    mockRows = [
      row("user", {
        text: "Look at this screenshot",
        images: [{ name: "shot.png", url: "data:image/png;base64,AAAA" }],
      }),
    ];
    const r = await fire(ctx());
    expect(r.kind).toBe("continue");
  });

  it("still fires planning-only when there is NO image (exemption is not a blanket off-switch)", async () => {
    mockRows = [row("user", { text: "Fix the login layout" })];
    const r = await fire(ctx());
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("post-turn:planning-only");
  });

  it("does not let a synthetic nudge row mask the earlier image turn", async () => {
    mockRows = [
      row("user", {
        text: "Look at this screenshot",
        images: [{ name: "shot.png", url: "data:image/png;base64,AAAA" }],
      }),
      // Engine-injected nudge is also role:"user" — must not reset the signal.
      row("user", { kind: "nudge", text: "You called tools but none committed..." }),
    ];
    const r = await fire(ctx());
    expect(r.kind).toBe("continue");
  });
});

describe("post-turn-detector — reasoning-only vs empty-response routing (HE-5)", () => {
  beforeEach(() => {
    _resetMiddlewareStates();
    mockRows = [row("user", { text: "Refactor the parser" })];
  });

  it("routes a reasoning-burn turn (reasoning seen, no visible text) to reasoning-only", async () => {
    // Pre-fix the middleware hardcoded hasReasoning:false/completionTokens:0,
    // so this turn read as "produced no visible reply" (empty-response) —
    // inviting a from-scratch restart instead of "continue from partial state".
    const r = await fire(ctx({ assistantContent: "", hasReasoning: true, completionTokens: 812 }));
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("post-turn:reasoning-only");
  });

  it("does not claim 'produced no visible reply' when the provider counted output tokens", async () => {
    // Codex-style reasoning burn: tokens billed, nothing visible, no
    // heartbeat (reasoning is server-side). Must not misroute to
    // empty-response; the tokens prove the model produced SOMETHING.
    const r = await fire(ctx({ assistantContent: "", hasReasoning: false, completionTokens: 512 }));
    expect((r as { reason?: string }).reason).not.toBe("post-turn:empty-response");
  });

  it("still fires empty-response for a genuinely empty turn (no reasoning, zero tokens)", async () => {
    const r = await fire(ctx({ assistantContent: "" }));
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("post-turn:empty-response");
  });
});
