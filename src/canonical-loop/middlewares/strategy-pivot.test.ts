import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalLoopContext } from "./types.js";

const rows = vi.hoisted(() => [] as Array<{ turnIdx: number; content: unknown }>);
const forceCompactNext = vi.hoisted(() => vi.fn());

vi.mock("../store.js", () => ({ readOpMessages: () => rows }));
vi.mock("../turn-loop/compact-history.js", () => ({ forceCompactNext }));

import { _resetPersistedPivotRestores, autonomousStrategyPivot, restorePersistedPivot } from "./strategy-pivot.js";

function ctx(toolNames: string[] = []): CanonicalLoopContext {
  return {
    op: { id: "pivot-op", lane: "build" },
    turnIdx: 9,
    toolNames: new Set(toolNames),
  } as unknown as CanonicalLoopContext;
}

function addPivot(strategyId: string, epoch = 1, turnIdx = rows.length): void {
  rows.push({
    turnIdx,
    content: { kind: "nudge", strategyPivot: { pattern: "exact-repeat", strategyId, epoch } },
  });
}

describe("autonomous strategy pivots", () => {
  beforeEach(() => {
    rows.length = 0;
    forceCompactNext.mockClear();
    _resetPersistedPivotRestores();
  });

  it("walks four distinct deterministic strategies, then starts a new epoch", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = autonomousStrategyPivot(ctx(), "exact-repeat");
      expect(result.kind).toBe("nudge");
      if (result.kind !== "nudge") throw new Error("expected nudge");
      const meta = result.metadata?.strategyPivot;
      ids.push(meta?.strategyId ?? "");
      addPivot(meta!.strategyId, meta!.epoch);
    }
    expect(ids.slice(0, 4)).toEqual([
      "evidence-synthesis",
      "alternate-route",
      "step-redecomposition",
      "context-refresh",
    ]);
    expect(ids[4]).toBe("evidence-synthesis");
    const fifth = autonomousStrategyPivot(ctx(), "exact-repeat");
    if (fifth.kind !== "nudge") throw new Error("expected nudge");
    expect(fifth.metadata?.strategyPivot?.epoch).toBe(2);
    expect(forceCompactNext).not.toHaveBeenCalled();
  });

  it("mentions delegation only when agent_spawn is already advertised", () => {
    addPivot("evidence-synthesis");
    addPivot("alternate-route");
    const withoutSpawn = autonomousStrategyPivot(ctx(), "flat-evidence");
    const withSpawn = autonomousStrategyPivot(ctx(["agent_spawn"]), "flat-evidence");
    if (withoutSpawn.kind !== "nudge" || withSpawn.kind !== "nudge") throw new Error("expected nudges");
    expect(withoutSpawn.message).not.toContain("agent_spawn");
    expect(withSpawn.message).toContain("agent_spawn");
  });

  it("rehydrates a current-turn refresh without creating another nudge", () => {
    addPivot("context-refresh", 3, 9);
    expect(restorePersistedPivot(ctx())).toBe(true);
    expect(restorePersistedPivot(ctx())).toBe(true);
    expect(rows).toHaveLength(1);
    expect(forceCompactNext).toHaveBeenCalledWith("pivot-op");
    expect(forceCompactNext).toHaveBeenCalledTimes(1);
  });
});
