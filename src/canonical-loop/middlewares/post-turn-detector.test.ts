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
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";

function row(role: OpMessageRow["role"], content: unknown): OpMessageRow {
  return { messageId: "m", opId: "o", turnIdx: 0, seqInTurn: 0, role, content, createdAt: "" };
}

let opCounter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return makeCanonicalLoopContext({
    op: { id: `op-ptd-${opCounter++}`, lane: "agent" },
    turnIdx: 4,
    toolCalls: [],
    toolsCalledThisOp: new Set<string>(),
    // Both op-level committing tallies the host builds (types.ts). The
    // middleware passes BOTH down — the substantive one to planning-only, the
    // raw one to uncommitted-turn / evidence-stale — so every fixture below
    // sets each independently to show the two are not interchangeable.
    committingToolsThisOp: new Set<string>(),
    substantiveCommittingToolsThisOp: new Set<string>(),
    evidenceHistory: [],
    // Vision reply: "I see X, try Y". Regex-reads as a stalled plan
    // ("I'll fix ... next") → planning-only fires UNLESS the image exemption
    // engages.
    assistantContent: "I can see the login button overlaps the header. I'll fix the layout next.",
    ...over,
  });
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

// C7: the middleware hands the detectors commit verdicts the host already
// computed instead of letting them re-run the name-only isCommittingTool over
// toolsCalledThisOp — and it hands them DIFFERENT ones, because they ask
// different questions:
//   - planning-only  → SUBSTANTIVE (arg-aware, task_* ledger excluded)
//   - uncommitted-turn / evidence-stale → the UNION of RAW and SUBSTANTIVE
//     ("is there ANY committed side effect on record?"), because RAW alone is
//     blind to the three arg-aware tools and SUBSTANTIVE alone is blind to the
//     task_* ledger. Every op below pins one side of that: an op whose only
//     commit is its own ledger must still be judged uncommitted by
//     planning-only, and an op whose only work was a pdf/browser/http_request
//     commit must NOT be nudged to "commit work" by either of the other two.
// None of these could appear in the old fixtures, which never contained
// pdf/browser/http_request or a task_*-only op.
describe("post-turn-detector — commit signal routing (C7)", () => {
  beforeEach(() => {
    _resetMiddlewareStates();
    mockRows = [row("user", { text: "Write up the vendor report and send it over" })];
  });

  // Committing by NAME (task_create is workspace-write) but not substantive.
  const ledgerOnly = {
    toolsCalledThisOp: new Set(["read", "task_create"]),
    committingToolsThisOp: new Set(["task_create"]),
    substantiveCommittingToolsThisOp: new Set<string>(),
  };
  // The op the RAW/SUBSTANTIVE split protects: the user asked for findings, not
  // a change, and open-steps seeded a task list on turn 0. Substantive is 0 by
  // definition, so routing the substantive verdict to uncommitted-turn /
  // evidence-stale would nag it to "commit work" it was never asked to do.
  const readOnlyResearch = {
    toolsCalledThisOp: new Set(["task_create", "web_search", "read", "grep"]),
    committingToolsThisOp: new Set(["task_create"]),
    substantiveCommittingToolsThisOp: new Set<string>(),
  };
  // Real work the name-only layer cannot see: pdf/browser are arg-aware, so
  // isCommittingTool answers false and the RAW tally is empty for them.
  const pdfCreateOnly = {
    toolsCalledThisOp: new Set(["read", "pdf"]),
    committingToolsThisOp: new Set<string>(),
    substantiveCommittingToolsThisOp: new Set(["pdf"]),
  };
  const browserSubmitOnly = {
    toolsCalledThisOp: new Set(["read", "browser"]),
    committingToolsThisOp: new Set<string>(),
    substantiveCommittingToolsThisOp: new Set(["browser"]),
  };
  const httpPostOnly = {
    toolsCalledThisOp: new Set(["read", "http_request"]),
    committingToolsThisOp: new Set<string>(),
    substantiveCommittingToolsThisOp: new Set(["http_request"]),
  };

  const RECAP_THEN_PROMISE = "Created the report. I'll send it to the client next.";
  const NEUTRAL = "Looked through the vendor docs and the current draft.";

  it("planning-only: still nudges an op whose only commit was its task ledger", async () => {
    // RAW is non-empty here — proof the site reads the substantive verdict.
    const r = await fire(ctx({ ...ledgerOnly, assistantContent: RECAP_THEN_PROMISE }));
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("post-turn:planning-only");
  });

  it("planning-only: stands down on a recap of an op whose only work was a pdf create", async () => {
    // RAW is empty here, SUBSTANTIVE is not.
    //
    // Deliberately run at the DEFAULT turnIdx 4, not isolated at 0: the whole
    // stack has to agree on this one TurnState. When uncommitted-turn read RAW
    // alone it fired here — "you called tools but none of them committed" — on
    // the very turn planning-only stood down for having done real work, so this
    // test had to pin turnIdx 0 to dodge its own stack. The union removes the
    // contradiction, and running at turnIdx 4 is what proves it.
    const r = await fire(ctx({ ...pdfCreateOnly, assistantContent: RECAP_THEN_PROMISE }));
    expect(r.kind).toBe("continue");
  });

  it("uncommitted-turn: does NOT nudge a read-only research op", async () => {
    const r = await fire(ctx({ ...readOnlyResearch, assistantContent: NEUTRAL }));
    expect(r.kind).toBe("continue");
  });

  it("uncommitted-turn: stands down for an op whose only commit was its task ledger", async () => {
    const r = await fire(ctx({ ...ledgerOnly, assistantContent: NEUTRAL }));
    expect(r.kind).toBe("continue");
  });

  // SUBSTANTIVE is non-empty and RAW is empty for all three: `browser`, `pdf`
  // and `http_request` are the ARG_AWARE_TOOLS, so the name-only
  // isCommittingTool answers false for them and RAW alone reads these ops as
  // having committed nothing. Nudging them tells a model that just submitted a
  // form / wrote a PDF / POSTed a request to "call the tool that actually
  // commits work" — which it did. The union is what stands the detector down.
  for (const [label, fixture] of [
    ["a browser submit", browserSubmitOnly],
    ["a pdf create", pdfCreateOnly],
    ["an http_request POST", httpPostOnly],
  ] as const) {
    it(`uncommitted-turn: does NOT nudge when the op's only work was ${label}`, async () => {
      const r = await fire(ctx({ ...fixture, assistantContent: NEUTRAL }));
      expect(r.kind).toBe("continue");
    });
  }

  // turnIdx 0 keeps uncommitted-turn (which skips iteration 0) out of the way,
  // so the assertion is about evidence-stale and nothing else. Seeding two
  // equal counts makes the window flat once the middleware pushes this turn's.
  it("evidence-stale: does NOT nudge a read-only research op on a flat evidence window", async () => {
    const r = await fire(ctx({
      ...readOnlyResearch, assistantContent: NEUTRAL, turnIdx: 0, evidenceHistory: [0, 0],
    }));
    expect(r.kind).toBe("continue");
  });

  it("evidence-stale: stands down for a task-ledger-only op on a flat evidence window", async () => {
    const r = await fire(ctx({
      ...ledgerOnly, assistantContent: NEUTRAL, turnIdx: 0, evidenceHistory: [0, 0],
    }));
    expect(r.kind).toBe("continue");
  });

  // Same three ops, same reason as the uncommitted-turn loop above — this
  // detector reads the identical union, so a flat evidence window must not turn
  // a landed pdf/browser/http_request commit into a "you are spinning" nudge.
  for (const [label, fixture] of [
    ["a pdf create", pdfCreateOnly],
    ["a browser submit", browserSubmitOnly],
    ["an http_request POST", httpPostOnly],
  ] as const) {
    it(`evidence-stale: does NOT nudge when the op's only work was ${label}`, async () => {
      const r = await fire(ctx({
        ...fixture, assistantContent: NEUTRAL, turnIdx: 0, evidenceHistory: [0, 0],
      }));
      expect(r.kind).toBe("continue");
    });
  }

  // The control the six stand-downs above rest on: with NOTHING committed by
  // either projection, both detectors still fire. Without this, the union could
  // be "always true" and every assertion above would still pass.
  const nothingCommitted = {
    toolsCalledThisOp: new Set(["read", "grep"]),
    committingToolsThisOp: new Set<string>(),
    substantiveCommittingToolsThisOp: new Set<string>(),
  };

  it("uncommitted-turn: still nudges an op that committed nothing at all", async () => {
    const r = await fire(ctx({ ...nothingCommitted, assistantContent: NEUTRAL }));
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("post-turn:uncommitted-turn");
  });

  it("evidence-stale: still nudges an op that committed nothing at all", async () => {
    const r = await fire(ctx({
      ...nothingCommitted, assistantContent: NEUTRAL, turnIdx: 0, evidenceHistory: [0, 0],
    }));
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("post-turn:evidence-stale");
  });
});
