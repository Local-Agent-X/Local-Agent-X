/**
 * CROSS-SEAM CONTRACT: post-turn-detector's `committedWorkOrLedger` union is
 * committing-tool-check's `opCommittedWork`.
 *
 * post-turn-detector.ts computes the detector input
 *   ctx.committingToolsThisOp.size > 0 || ctx.substantiveCommittingToolsThisOp.size > 0
 * from two tallies host.ts builds. That expression is EXACTLY the repo's
 * canonical "did this op commit anything?" predicate — `opCommittedWork(rows)`,
 * arg-aware with the `task_*` ledger included — for every summary row dispatch
 * can write. Nothing in the types ties the two together: host.ts owns how each
 * tally is built, committing-tool-check.ts owns opCommittedWork, and a change
 * to either would silently stop the union from meaning what two detectors
 * (uncommitted-turn, evidence-stale) believe it means. THIS file is the tie.
 *
 * Why the union is not simply replaced by a call to opCommittedWork: that adds
 * a fourth op_turns walk per turn (buildCanonicalLoopContext already runs three
 * times), and a third ctx Set is explicitly forbidden by host.ts — the previous
 * "abort-safety" projection shipped unread and was reverted. The inline union
 * plus this test is the minimal correct shape, so if this goes red the fix is
 * to make the union match opCommittedWork again, NOT to add a Set.
 *
 * The equivalence is conditional on one fact, pinned at the bottom: dispatch
 * (turn-loop/dispatch-tools.ts) is the sole writer of `committing`, and it
 * writes `isCommittingCall(tool, args)`, which never answers false where
 * `isCommittingTool(tool)` answers true. A hand-forged `committing:false` on a
 * name-committing tool DOES diverge, and that row cannot be produced.
 */
import { describe, it, expect, vi } from "vitest";
import type { CanonicalLoopContext } from "./types.js";

// buildCanonicalLoopContext walks op_turns; drive that walk from memory.
let mockTurns: Array<{ toolCallSummary: OpTurnToolSummary[] }> = [];
vi.mock("../store.js", () => ({
  readOpTurns: vi.fn(() => mockTurns),
  readOpMessages: vi.fn(() => []),
}));
vi.mock("../op-model.js", () => ({ resolveOpModel: vi.fn(() => "test-model") }));

// Capture the TurnState post-turn-detector actually hands the detector stack,
// so this test binds to the real call site rather than to a copy of its
// expression sitting in a test file.
let capturedState: { committedWorkOrLedger: boolean } | null = null;
vi.mock("../../agent-loop-detectors/index.js", () => ({
  runPostTurnDetectors: vi.fn((state: { committedWorkOrLedger: boolean }) => {
    capturedState = state;
    return null;
  }),
  computeEvidenceCount: vi.fn(() => 0),
  createRetryCounters: vi.fn(() => ({})),
  countEnumeratedSteps: vi.fn(() => 0),
}));

import { buildCanonicalLoopContext } from "./host.js";
import { postTurnDetectorMiddleware } from "./post-turn-detector.js";
import {
  opCommittedWork,
  isCommittingCall,
  isCommittingTool,
  type OpTurnToolSummary,
} from "../../committing-tool-check.js";
import { TOOLS } from "../../tool-registry.js";
import type { Op } from "../../ops/types.js";

let opCounter = 0;

/** A real context over one stored turn carrying `rows`. */
function contextOver(rows: OpTurnToolSummary[]): CanonicalLoopContext {
  mockTurns = [{ toolCallSummary: rows }];
  const op = { id: `op-union-${opCounter++}`, lane: "agent", task: "" } as unknown as Op;
  return buildCanonicalLoopContext({ op, turnIdx: 3, evidenceHistory: [] });
}

/** The expression post-turn-detector.ts assigns to `committedWorkOrLedger`. */
function unionOf(ctx: CanonicalLoopContext): boolean {
  return ctx.committingToolsThisOp.size > 0 || ctx.substantiveCommittingToolsThisOp.size > 0;
}

/** opCommittedWork over the same rows, as one stored turn. */
function canonicalOf(rows: OpTurnToolSummary[]): boolean {
  return opCommittedWork([{ toolCallSummary: rows }]);
}

/** Representative row shapes. `expected` is stated so the assertion cannot pass
 *  by both sides breaking identically. */
const SHAPES: Array<{ name: string; rows: OpTurnToolSummary[]; expected: boolean }> = [
  {
    name: "a write",
    rows: [{ tool: "write", resultStatus: "ok", committing: true }],
    expected: true,
  },
  {
    name: "a pdf create (arg-aware: invisible to the name-only tally)",
    rows: [{ tool: "pdf", resultStatus: "ok", committing: true }],
    expected: true,
  },
  {
    name: "a pdf read (arg-aware: commits nothing)",
    rows: [{ tool: "pdf", resultStatus: "ok", committing: false }],
    expected: false,
  },
  {
    name: "a browser submit",
    rows: [{ tool: "browser", resultStatus: "ok", committing: true }],
    expected: true,
  },
  {
    name: "a ledger-only task_create (substantive drops it, raw keeps it)",
    rows: [{ tool: "task_create", resultStatus: "ok", committing: true }],
    expected: true,
  },
  {
    name: "a BLOCKED pdf create still stamped committing:true",
    rows: [{ tool: "pdf", resultStatus: "blocked", committing: true }],
    expected: false,
  },
  {
    name: "a legacy row with no committing field (write)",
    rows: [{ tool: "write", resultStatus: "ok" }],
    expected: true,
  },
  {
    name: "a legacy row with no committing field (pdf reads as name-only false)",
    rows: [{ tool: "pdf", resultStatus: "ok" }],
    expected: false,
  },
  { name: "no rows at all", rows: [], expected: false },
  {
    name: "read-only exploration only",
    rows: [
      { tool: "read", resultStatus: "ok", committing: false },
      { tool: "grep", resultStatus: "ok", committing: false },
      { tool: "web_search", resultStatus: "ok", committing: false },
    ],
    expected: false,
  },
  {
    name: "a refused write plus the op's own ledger",
    rows: [
      { tool: "write", resultStatus: "error", committing: true },
      { tool: "task_create", resultStatus: "ok", committing: true },
    ],
    expected: true,
  },
  {
    name: "a browser navigate that committed nothing, alongside a pdf read",
    rows: [
      { tool: "browser", resultStatus: "ok", committing: false },
      { tool: "pdf", resultStatus: "ok", committing: false },
    ],
    expected: false,
  },
];

describe("committedWorkOrLedger === opCommittedWork", () => {
  it.each(SHAPES)("agrees on $name", ({ rows, expected }) => {
    const union = unionOf(contextOver(rows));
    expect(union).toBe(canonicalOf(rows));
    expect(union).toBe(expected);
  });

  it("post-turn-detector hands the detector stack exactly that union", async () => {
    for (const shape of SHAPES) {
      capturedState = null;
      const ctx = contextOver(shape.rows);
      await postTurnDetectorMiddleware.afterModelCall!(ctx);
      expect(capturedState, `no state captured for ${shape.name}`).not.toBeNull();
      expect(
        (capturedState as unknown as { committedWorkOrLedger: boolean }).committedWorkOrLedger,
        shape.name,
      ).toBe(canonicalOf(shape.rows));
    }
  });

  it("holds for every registry tool x resultStatus x dispatch-writable committing value", () => {
    // The `committing` values dispatch can actually stamp for a tool are
    // whatever isCommittingCall returns for it — one value for every tool
    // outside ARG_AWARE_TOOLS, both values for browser / http_request / pdf.
    // The legacy shape (field absent) is included for every tool.
    const ARG_SHAPES: unknown[] = [
      {},
      undefined,
      { _raw: "not json" },
      { action: "read" },
      { action: "create" },
      { action: "click", text: "Submit order" },
      { action: "click_text", text: "Home" },
      { action: "act", text: "click Purchase Orders in the left navigation" },
      { method: "GET", url: "https://example.test" },
      { method: "POST", url: "https://example.test" },
    ];
    const STATUSES = ["ok", "error", "blocked", "cancelled", "declined"];

    const mismatches: string[] = [];
    let checked = 0;
    for (const tool of Object.keys(TOOLS)) {
      const reachable = new Set<boolean>();
      for (const args of ARG_SHAPES) reachable.add(isCommittingCall(tool, args));

      for (const resultStatus of STATUSES) {
        const rows: OpTurnToolSummary[] = [{ tool, resultStatus }];
        for (const committing of reachable) rows.push({ tool, resultStatus, committing });
        for (const row of rows) {
          checked++;
          if (unionOf(contextOver([row])) !== canonicalOf([row])) {
            mismatches.push(`${tool} status=${resultStatus} committing=${String(row.committing)}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    // Guard against the sweep silently emptying out (a registry rename, an
    // exception swallowed upstream) and passing vacuously.
    expect(Object.keys(TOOLS).length).toBeGreaterThan(150);
    expect(checked).toBeGreaterThan(1500);
  });

  it("pins the ONE row shape that would diverge — and that dispatch cannot write", () => {
    // A name-committing tool carrying committing:false. The union answers true
    // (the raw name-only tally counts it), opCommittedWork answers false (the
    // recorded verdict wins). This is the exact shape whose absence makes the
    // equivalence hold, so assert both the divergence and its unreachability.
    const forged: OpTurnToolSummary[] = [{ tool: "write", resultStatus: "ok", committing: false }];
    expect(unionOf(contextOver(forged))).toBe(true);
    expect(canonicalOf(forged)).toBe(false);

    // Unreachable: for every registry tool, isCommittingCall never answers
    // false where isCommittingTool answers true, so dispatch never stamps it.
    const ARG_SHAPES: unknown[] = [
      {}, undefined, { _raw: "x" }, { action: "read" }, { action: "create" },
      { action: "click", text: "Home" }, { method: "GET", url: "u" },
    ];
    const forgeable = Object.keys(TOOLS).filter(
      tool => isCommittingTool(tool) && ARG_SHAPES.some(args => !isCommittingCall(tool, args)),
    );
    expect(forgeable).toEqual([]);
  });
});
