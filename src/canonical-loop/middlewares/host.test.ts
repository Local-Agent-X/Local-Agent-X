/**
 * buildCanonicalLoopContext's op_turns projection.
 *
 * Middlewares used to answer "did this op do work?" by calling readOpTurns
 * themselves; they now read sets host builds inside the walk it already does,
 * which makes THIS the seam where a `pdf create` becomes evidence of work and a
 * `pdf read` does not. TWO sets come out of that one walk and they answer TWO
 * different questions — raw name-only (task_* ledger IN, arg-aware tools
 * invisible) and substantive (arg-aware, ledger OUT). Neither is a subset of
 * the other; every direction is pinned here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store.js", () => ({
  readOpTurns: vi.fn(() => []),
  readOpMessages: vi.fn(() => []),
}));
vi.mock("../op-model.js", () => ({ resolveOpModel: vi.fn(() => "test-model") }));

import { buildCanonicalLoopContext } from "./host.js";
import { readOpTurns } from "../store.js";
import type { Op } from "../../ops/types.js";

const mockOpTurns = vi.mocked(readOpTurns);

const OP = { id: "op-host-projection", lane: "agent", task: "do the thing" } as unknown as Op;

/** Build a context over ONE stored turn with the given summary rows. */
function ctxOver(...summary: Array<Record<string, unknown>>) {
  mockOpTurns.mockReturnValue([{ toolCallSummary: summary }] as never);
  return buildCanonicalLoopContext({ op: OP, turnIdx: 0, evidenceHistory: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOpTurns.mockReturnValue([] as never);
});

describe("substantiveCommittingToolsThisOp — the arg-aware projection", () => {
  it("credits a pdf CREATE, which the name-only raw tally cannot see", () => {
    const ctx = ctxOver({ tool: "pdf", resultStatus: "ok", committing: true });
    expect([...ctx.substantiveCommittingToolsThisOp]).toEqual(["pdf"]);
    // The raw set stays name-only on purpose — mid-turn-stale reads it.
    expect(ctx.committingToolsThisOp.size).toBe(0);
    expect(ctx.toolsCalledThisOp.has("pdf")).toBe(true);
  });

  it("does not credit a pdf READ", () => {
    const ctx = ctxOver({ tool: "pdf", resultStatus: "ok", committing: false });
    expect(ctx.substantiveCommittingToolsThisOp.size).toBe(0);
    expect(ctx.toolsCalledThisOp.has("pdf")).toBe(true);
  });

  it("credits a committing browser click and an http_request write", () => {
    const ctx = ctxOver(
      { tool: "browser", resultStatus: "ok", committing: false },
      { tool: "browser", resultStatus: "ok", committing: true },
      { tool: "http_request", resultStatus: "ok", committing: true },
    );
    expect([...ctx.substantiveCommittingToolsThisOp].sort()).toEqual(["browser", "http_request"]);
  });

  it("excludes the op's own task ledger", () => {
    const ctx = ctxOver(
      { tool: "task_create", resultStatus: "ok" },
      { tool: "task_update", resultStatus: "ok" },
    );
    expect(ctx.substantiveCommittingToolsThisOp.size).toBe(0);
    // …while the raw name-only tally still counts planning, which is the
    // reason task_create is in the committing registry at all.
    expect([...ctx.committingToolsThisOp].sort()).toEqual(["task_create", "task_update"]);
  });

  it("does NOT count refused work: a blocked call still carries committing:true", () => {
    for (const resultStatus of ["blocked", "declined", "error"]) {
      const ctx = ctxOver({ tool: "pdf", resultStatus, committing: true });
      expect(ctx.substantiveCommittingToolsThisOp.size).toBe(0);
      expect(ctx.toolsCalledThisOp.size).toBe(0);
      // …but it was still ATTEMPTED, which the handoff gate keys on.
      expect(ctx.attemptedToolsThisOp.has("pdf")).toBe(true);
    }
  });

  it("reads a legacy row (no committing key) exactly as before", () => {
    const wrote = ctxOver({ tool: "write", resultStatus: "ok" });
    expect([...wrote.substantiveCommittingToolsThisOp]).toEqual(["write"]);
    expect([...wrote.committingToolsThisOp]).toEqual(["write"]);

    const readPdf = ctxOver({ tool: "pdf", resultStatus: "ok" });
    expect(readPdf.substantiveCommittingToolsThisOp.size).toBe(0);
    expect(readPdf.committingToolsThisOp.size).toBe(0);
  });

  it("walks op_turns exactly ONCE per context build", () => {
    ctxOver({ tool: "write", resultStatus: "ok" });
    expect(mockOpTurns).toHaveBeenCalledTimes(1);
  });
});

describe("the two sets are not nested", () => {
  // Each holds something the other does not, so neither `size === 0` is ever a
  // valid shortcut for "this op committed nothing". A third, arg-aware +
  // ledger-inclusive set used to live here for mid-turn-stale's abort brake; it
  // was reverted at that call site (the arg-aware `browser` verdict is a regex
  // over button text) and then deleted, because an unread Set with a
  // safety-sounding name is what invited the wiring in the first place.
  it("raw holds a name substantive does not, and vice versa", () => {
    const ctx = ctxOver(
      { tool: "task_create", resultStatus: "ok" },           // raw only
      { tool: "pdf", resultStatus: "ok", committing: true }, // substantive only
    );
    expect([...ctx.committingToolsThisOp]).toEqual(["task_create"]);
    expect([...ctx.substantiveCommittingToolsThisOp]).toEqual(["pdf"]);
    expect(ctx.committingToolsThisOp.has("pdf")).toBe(false);
    expect(ctx.substantiveCommittingToolsThisOp.has("task_create")).toBe(false);
  });

  it("a legacy row (no committing key) is read by name in both", () => {
    // Name-only is blind to the arg-aware tools, so a legacy browser row is
    // absent from BOTH — unchanged behavior for history already on disk.
    const wrote = ctxOver({ tool: "write", resultStatus: "ok" });
    expect([...wrote.committingToolsThisOp]).toEqual(["write"]);
    expect([...wrote.substantiveCommittingToolsThisOp]).toEqual(["write"]);
    const browsed = ctxOver({ tool: "browser", resultStatus: "ok" });
    expect(browsed.committingToolsThisOp.size).toBe(0);
    expect(browsed.substantiveCommittingToolsThisOp.size).toBe(0);
  });

  it("still walks op_turns exactly ONCE with both sets built", () => {
    ctxOver(
      { tool: "task_create", resultStatus: "ok" },
      { tool: "browser", resultStatus: "ok", committing: true },
      { tool: "write", resultStatus: "ok" },
    );
    expect(mockOpTurns).toHaveBeenCalledTimes(1);
  });
});
