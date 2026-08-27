/**
 * Regression: ToolCallSummary.committing — the arg-aware verdict dispatch
 * records because the row keeps argsHash, not args — is OPTIONAL, and every
 * op turn already on disk was written without it. If the validators ever
 * demand the key, readOpTurn rejects those turns and the loop loses its
 * history; if they ever accept a non-boolean, a corrupt row reads as a
 * verdict. Both directions are pinned here, structurally and through the
 * real insertOpTurn/readOpTurn persistence path.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isLegacyOpTurnRow, isOpTurnRow } from "./turn-commit-validation.js";
import { insertOpTurn, readOpTurn } from "./store.js";
import type { OpTurnRow, ToolCallSummary } from "./types.js";
import { newOpId } from "../ops/op-store.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const trackedIds: string[] = [];

afterAll(() => {
  for (const id of trackedIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

/** A row exactly as persisted, with whatever summary rows are handed in. */
function turnRow(opId: string, toolCallSummary: ToolCallSummary[]): OpTurnRow {
  return {
    opId,
    turnIdx: 0,
    providerState: { adapterName: "fake", adapterVersion: "1", providerPayload: null },
    toolCallSummary,
    terminalReason: null,
    redirectConsumed: false,
    createdAt: new Date().toISOString(),
  };
}

/** Raw JSON shape — bypasses the type so the absent/invalid key is testable. */
function rawRow(summary: unknown): unknown {
  return { ...turnRow("op-x", []), toolCallSummary: [summary] };
}

const legacySummary = { tool: "pdf", argsHash: "a", resultStatus: "ok", durationMs: 2 };

describe("isToolSummary accepts rows with AND without the committing verdict", () => {
  it("accepts a legacy row that has no committing key at all", () => {
    expect("committing" in legacySummary).toBe(false);
    expect(isOpTurnRow(rawRow(legacySummary))).toBe(true);
    expect(isLegacyOpTurnRow(rawRow(legacySummary))).toBe(true);
  });

  it("accepts both verdicts", () => {
    expect(isOpTurnRow(rawRow({ ...legacySummary, committing: true }))).toBe(true);
    expect(isOpTurnRow(rawRow({ ...legacySummary, committing: false }))).toBe(true);
  });

  it("rejects a non-boolean verdict rather than guessing", () => {
    expect(isOpTurnRow(rawRow({ ...legacySummary, committing: "yes" }))).toBe(false);
    expect(isOpTurnRow(rawRow({ ...legacySummary, committing: null }))).toBe(false);
    expect(isLegacyOpTurnRow(rawRow({ ...legacySummary, committing: 1 }))).toBe(false);
  });

  it("still enforces the required fields", () => {
    expect(isOpTurnRow(rawRow({ ...legacySummary, durationMs: undefined }))).toBe(false);
    expect(isOpTurnRow(rawRow({ ...legacySummary, resultStatus: "weird" }))).toBe(false);
  });
});

describe("the verdict survives the real persistence path", () => {
  it("round-trips through insertOpTurn/readOpTurn", () => {
    const opId = newOpId("commit_verdict_rt");
    trackedIds.push(opId);
    const summary: ToolCallSummary[] = [
      { tool: "pdf", argsHash: "a", resultStatus: "ok", durationMs: 2, committing: false },
      { tool: "pdf", argsHash: "b", resultStatus: "ok", durationMs: 3, committing: true },
    ];
    expect(insertOpTurn(turnRow(opId, summary))).toBe(true);

    const back = readOpTurn(opId, 0);
    expect(back?.toolCallSummary.map(s => s.committing)).toEqual([false, true]);
  });

  it("loads a turn written before the verdict existed, verdict undefined", () => {
    const opId = newOpId("commit_verdict_legacy");
    trackedIds.push(opId);
    const summary = [legacySummary] as unknown as ToolCallSummary[];
    expect(insertOpTurn(turnRow(opId, summary))).toBe(true);

    const back = readOpTurn(opId, 0);
    expect(back?.toolCallSummary).toHaveLength(1);
    expect(back?.toolCallSummary[0].committing).toBeUndefined();
    expect(back?.toolCallSummary[0].tool).toBe("pdf");
  });
});
