/**
 * Regression suite for `diskRedirectMatches` in
 * src/canonical-loop/checkpoint.ts.
 *
 * `diskRedirectMatches(opId, instructionId)` is the private predicate that
 * decides whether `commitTurn` clears the on-disk redirect column after a
 * turn folds an instruction into its prompt. It returns true ONLY when the
 * instructionId currently sitting on disk equals the in-memory token being
 * consumed; a stale / empty / mismatched disk redirect returns false so the
 * newer instruction survives for the next turn (latest-wins, PRD §13).
 *
 * The function is not exported, so it is exercised through the public
 * `commitTurn` surface. Its return value is observable as the redirect
 * column state on disk after the commit:
 *   - match   → column cleared (redirectInstruction/redirectReceivedAt null)
 *   - no match → column preserved as-is
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { commitTurn } from "../src/canonical-loop/index.js";
import { readOp, writeOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import type {
  CommitTurnInput,
  ProviderStateEnvelope,
  RedirectInstruction,
} from "../src/canonical-loop/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

afterAll(() => {
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

const PROVIDER_STATE: ProviderStateEnvelope = {
  adapterName: "fake",
  adapterVersion: "1",
  providerPayload: null,
};

function mkOp(label: string): Op {
  return {
    id: track(newOpId(`ckpt_redir_${label}`)),
    type: "freeform",
    task: `checkpoint-redirect ${label}`,
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-checkpoint-redirect",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

/** Simulate a control-API redirect write landing on disk (plain writeOp). */
function setDiskRedirect(op: Op, instr: RedirectInstruction): void {
  const fresh = readOp(op.id) ?? op;
  if (!fresh.canonical) fresh.canonical = {};
  fresh.canonical.redirectInstruction = instr;
  fresh.canonical.redirectReceivedAt = instr.receivedAt;
  writeOp(fresh);
}

function commitInput(op: Op, over: Partial<CommitTurnInput> = {}): CommitTurnInput {
  return {
    op,
    turnIdx: 0,
    providerState: PROVIDER_STATE,
    messages: [{ role: "assistant", content: "ok" }],
    toolCallSummary: [],
    terminalReason: null,
    ...over,
  };
}

describe("diskRedirectMatches — clears redirect only when disk == consumed token", () => {
  it("clears the redirect column when the consumed instructionId equals the one on disk (match)", () => {
    const op = mkOp("match");
    writeOp(op);
    const instr: RedirectInstruction = {
      instructionId: "instr-MATCH",
      text: "go this way",
      receivedAt: new Date().toISOString(),
    };
    setDiskRedirect(op, instr);
    // sanity: it's actually on disk before the commit
    expect(readOp(op.id)?.canonical?.redirectInstruction?.instructionId).toBe("instr-MATCH");

    commitTurn(commitInput(op, {
      redirectConsumed: true,
      redirectInstructionId: "instr-MATCH",
    }));

    const after = readOp(op.id);
    expect(after?.canonical?.redirectInstruction ?? null).toBeNull();
    expect(after?.canonical?.redirectReceivedAt ?? null).toBeNull();
  });

  it("preserves the redirect column when a NEWER redirect (different id) landed mid-turn (mismatch)", () => {
    const op = mkOp("mismatch");
    writeOp(op);
    // A newer instruction now sits on disk — different id than the one this
    // turn consumed. diskRedirectMatches must return false so it survives.
    const newer: RedirectInstruction = {
      instructionId: "instr-NEWER",
      text: "second direction",
      receivedAt: new Date().toISOString(),
    };
    setDiskRedirect(op, newer);

    commitTurn(commitInput(op, {
      redirectConsumed: true,
      redirectInstructionId: "instr-OLDER", // the one this turn applied
    }));

    const after = readOp(op.id);
    expect(after?.canonical?.redirectInstruction?.instructionId).toBe("instr-NEWER");
    expect(after?.canonical?.redirectInstruction?.text).toBe("second direction");
    expect(after?.canonical?.redirectReceivedAt).toBe(newer.receivedAt);
  });

  it("does not clear (no-op) when the disk redirect column is empty (empty)", () => {
    const op = mkOp("empty");
    writeOp(op); // no redirect column set at all
    expect(readOp(op.id)?.canonical?.redirectInstruction ?? null).toBeNull();

    commitTurn(commitInput(op, {
      redirectConsumed: true,
      redirectInstructionId: "instr-PHANTOM",
    }));

    // Still null — nothing to clear, nothing wrongly resurrected.
    const after = readOp(op.id);
    expect(after?.canonical?.redirectInstruction ?? null).toBeNull();
  });

  it("does not clear a matching disk redirect when no redirect was consumed this turn", () => {
    // redirectConsumed=false ⇒ appliedId is undefined ⇒ diskRedirectMatches
    // is never consulted ⇒ the column is preserved even though its id would
    // otherwise have matched.
    const op = mkOp("not-consumed");
    writeOp(op);
    const instr: RedirectInstruction = {
      instructionId: "instr-KEEP",
      text: "still pending",
      receivedAt: new Date().toISOString(),
    };
    setDiskRedirect(op, instr);

    commitTurn(commitInput(op, {
      redirectConsumed: false,
      redirectInstructionId: "instr-KEEP",
    }));

    const after = readOp(op.id);
    expect(after?.canonical?.redirectInstruction?.instructionId).toBe("instr-KEEP");
  });

  it("preserves a matching-id disk redirect when redirectInstructionId is undefined", () => {
    // Defensive: redirectConsumed=true but the caller passed no
    // instructionId. appliedId is undefined → diskRedirectMatches not
    // consulted → column preserved.
    const op = mkOp("no-applied-id");
    writeOp(op);
    const instr: RedirectInstruction = {
      instructionId: "instr-NOID",
      text: "orphan",
      receivedAt: new Date().toISOString(),
    };
    setDiskRedirect(op, instr);

    commitTurn(commitInput(op, {
      redirectConsumed: true,
      redirectInstructionId: undefined,
    }));

    const after = readOp(op.id);
    expect(after?.canonical?.redirectInstruction?.instructionId).toBe("instr-NOID");
  });
});
