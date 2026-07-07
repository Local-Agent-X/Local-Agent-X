/**
 * Crash-safety regression suite for src/canonical-loop/store.ts +
 * src/canonical-loop/checkpoint.ts (commitTurn).
 *
 * Two holes this locks down:
 *
 *  1. Swallowed write failures. `appendOpMessage` and `insertOpTurn` used to
 *     LOG-AND-SWALLOW a disk-full / EACCES / EISDIR write failure. A silently
 *     dropped message or turn row still let commitTurn proceed to the
 *     `succeeded` transition — the op reported success with data missing on
 *     disk. They now THROW; commitTurn must NOT transition to succeeded.
 *
 *  2. Orphaned op_messages on a mid-commit crash. commitTurn used to append
 *     op_messages BEFORE inserting the op_turns row. A crash between the two
 *     left op_messages rows with no op_turns row; on re-drive (readOpTurn
 *     returns null → NOT the idempotent path) those messages were appended a
 *     SECOND time → duplicate transcript. The fix writes the op_turns row
 *     FIRST — the row is the idempotency guard — so a crash mid-commit can
 *     never orphan messages, and a re-drive appends nothing.
 *
 * The failure seam is a real filesystem error, not a mock: the target path is
 * created as a DIRECTORY so the underlying appendFileSync/writeFileSync throws
 * EISDIR. This exercises the actual write path in store.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { commitTurn } from "../src/canonical-loop/index.js";
import { insertOpTurn, appendOpMessage, readOpMessages } from "../src/canonical-loop/store.js";
import { opMessagesPath, opTurnPath } from "../src/canonical-loop/schema.js";
import { opDir } from "../src/ops/event-log.js";
import { readOp, writeOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import type {
  CommitTurnInput,
  OpMessageRow,
  OpTurnRow,
  ProviderStateEnvelope,
} from "../src/canonical-loop/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

const PROVIDER_STATE: ProviderStateEnvelope = {
  adapterName: "fake",
  adapterVersion: "1",
  providerPayload: null,
};

function mkOp(label: string): Op {
  return {
    id: track(newOpId(`ckpt_crash_${label}`)),
    type: "freeform",
    task: `checkpoint-crash ${label}`,
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-checkpoint-crash",
    visibility: "private",
    status: "running",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: { state: "running" },
  };
}

function commitInput(op: Op, over: Partial<CommitTurnInput> = {}): CommitTurnInput {
  return {
    op,
    turnIdx: 0,
    providerState: PROVIDER_STATE,
    messages: [
      { role: "assistant", content: "reply-a" },
      { role: "assistant", content: "reply-b" },
    ],
    toolCallSummary: [],
    terminalReason: null,
    ...over,
  };
}

/** Make appendOpMessage fail: the op-messages.jsonl target becomes a dir. */
function failMessageWrites(opId: string): void {
  opDir(opId); // ensure the op dir exists
  const p = opMessagesPath(opId);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  mkdirSync(p, { recursive: true });
}

/** Make insertOpTurn fail: the op-turns/<idx>.json.tmp target becomes a dir. */
function failTurnWrite(opId: string, turnIdx: number): void {
  const p = opTurnPath(opId, turnIdx) + ".tmp";
  mkdirSync(p, { recursive: true });
}

function makeTurnRow(opId: string, turnIdx: number): OpTurnRow {
  return {
    opId,
    turnIdx,
    providerState: PROVIDER_STATE,
    toolCallSummary: [],
    terminalReason: null,
    redirectConsumed: false,
    createdAt: new Date().toISOString(),
  };
}

function makeMsgRow(opId: string, seqInTurn: number): OpMessageRow {
  return {
    messageId: `m-${seqInTurn}`,
    opId,
    turnIdx: 0,
    seqInTurn,
    role: "assistant",
    content: "x",
    createdAt: new Date().toISOString(),
  };
}

afterAll(() => {
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

// ── Problem 2: swallowed write failures now surface ──────────────────────

describe("store — write failures surface instead of swallow", () => {
  it("appendOpMessage THROWS on a real write failure (was: swallowed)", () => {
    const op = mkOp("append-throws");
    writeOp(op);
    failMessageWrites(op.id);
    expect(() => appendOpMessage(makeMsgRow(op.id, 0))).toThrow();
  });

  it("insertOpTurn THROWS on a real write failure, distinct from the exists→false path", () => {
    const op = mkOp("insert-throws");
    writeOp(op);
    failTurnWrite(op.id, 0);
    expect(() => insertOpTurn(makeTurnRow(op.id, 0))).toThrow();
  });

  it("insertOpTurn still returns false (not throw) when the row already exists (idempotency preserved)", () => {
    const op = mkOp("insert-idempotent");
    writeOp(op);
    expect(insertOpTurn(makeTurnRow(op.id, 0))).toBe(true);
    // Second insert of the same (opId, turnIdx) is the replay path: false,
    // NOT a throw — the write-failure throw must not be confused with this.
    expect(insertOpTurn(makeTurnRow(op.id, 0))).toBe(false);
  });
});

describe("commitTurn — a failed message write does NOT report succeeded", () => {
  it("throws and leaves the op non-terminal (never transitions running → succeeded) when a message write fails", () => {
    const op = mkOp("no-false-success");
    writeOp(op);
    failMessageWrites(op.id);

    expect(() =>
      commitTurn(commitInput(op, { terminalReason: "done" })),
    ).toThrow();

    // The whole point: the op must NOT have been transitioned to succeeded.
    // On the old swallow-and-succeed code this read `succeeded`.
    const after = readOp(op.id);
    expect(after?.canonical?.state).not.toBe("succeeded");
    expect(after?.status).not.toBe("completed");
  });
});

// ── Problem 1: op_turns written before op_messages (no orphan on crash) ───

describe("commitTurn — crash mid-commit cannot orphan op_messages", () => {
  it("writes the op_turns row BEFORE op_messages: a failed message write leaves the row committed and zero messages", () => {
    const op = mkOp("row-first");
    writeOp(op);
    failMessageWrites(op.id);

    expect(() => commitTurn(commitInput(op))).toThrow();

    // op_turns row is durable (written first). No op_messages landed, so
    // there is no orphaned message to duplicate on re-drive.
    expect(existsSync(opTurnPath(op.id, 0))).toBe(true);
    expect(readOpMessages(op.id).filter(m => m.turnIdx === 0)).toHaveLength(0);
  });

  it("re-drive after a crash between the two writes produces NO duplicate messages", () => {
    // Simulate a crash where the op_turns write is what fails on the first
    // attempt (the exact window that used to orphan messages on old code:
    // old code appended messages FIRST, so a turn-row failure left messages
    // on disk with no row, and the swallowed failure let the op "succeed").
    const op = mkOp("no-dup-on-redrive");
    writeOp(op);
    failTurnWrite(op.id, 0);

    // First attempt: on the fixed code the op_turns write is FIRST and now
    // throws, so NO messages are appended. (On old code messages were
    // appended before the swallowed turn-row failure → an orphan.)
    expect(() => commitTurn(commitInput(op))).toThrow();

    // Clear the seam — the "restart" after the crash.
    rmSync(opTurnPath(op.id, 0) + ".tmp", { recursive: true, force: true });

    // Re-drive the SAME turn_idx (worker resumes at the uncommitted turn).
    const fresh = readOp(op.id)!;
    const out = commitTurn(commitInput(fresh));

    // Exactly one copy of each message — no duplicate transcript. The input
    // has two messages; on the old code the first attempt would have landed
    // two orphans and the re-drive two more = four.
    const msgs = readOpMessages(op.id).filter(m => m.turnIdx === 0);
    expect(msgs).toHaveLength(2);
    expect(out.inserted).toBe(true);
    expect(existsSync(opTurnPath(op.id, 0))).toBe(true);
  });

  it("M-window: op_turns(N) lands, op_messages(N) drops on crash → op NOT falsely succeeded AND turn N not duplicated on re-drive", () => {
    // The exact window the M skeptic flagged for the write-reorder: because the
    // op_turns row is now written FIRST, there is a real gap where the turn row
    // is durable but a crash drops the op_messages for the SAME turn N. This
    // asserts the two things that gap must guarantee, driven end-to-end:
    //   (a) the op is NOT falsely succeeded — the message-write throw prevents
    //       commitTurn from reaching the succeeded transition even on a
    //       terminal "done" turn (an op that "completed" with a transcript hole
    //       is the failure the swallow-and-succeed code produced).
    //   (b) on re-drive of the SAME turn N, the durable op_turns row is the
    //       idempotency guard: commitTurn short-circuits and appends NO
    //       messages, so turn N is not duplicated.
    const op = mkOp("m-window-turn-lands-msgs-drop");
    writeOp(op);

    // Turn-row target is writable; message target is a DIRECTORY → the turn row
    // lands, then the very next op_messages append throws EISDIR. This is the
    // precise "turn N committed, messages dropped" seam, not the turn-row-fails
    // variant covered above.
    failMessageWrites(op.id);

    // First attempt: terminal "done" turn. The op_turns row is written first
    // and succeeds; the message append then throws before any state transition.
    expect(() =>
      commitTurn(commitInput(op, { terminalReason: "done" })),
    ).toThrow();

    // (a) The op must NOT have transitioned to succeeded — the throw fired
    // BEFORE transitionOp(op, "succeeded"). The durable turn row alone must
    // never be read as a completed op.
    const afterCrash = readOp(op.id);
    expect(afterCrash?.canonical?.state).not.toBe("succeeded");
    expect(afterCrash?.status).not.toBe("completed");

    // The recoverable disk shape: op_turns(N) present, zero op_messages(N).
    expect(existsSync(opTurnPath(op.id, 0))).toBe(true);
    expect(readOpMessages(op.id).filter(m => m.turnIdx === 0)).toHaveLength(0);

    // Clear the seam — the "restart" after the crash makes the message path
    // writable again. The durable turn row from the first attempt survives.
    rmSync(opMessagesPath(op.id), { recursive: true, force: true });

    // Re-drive the SAME turn N (recovery resumes at the uncommitted turn).
    const fresh = readOp(op.id)!;
    const out = commitTurn(commitInput(fresh, { terminalReason: "done" }));

    // (b) Turn N is not duplicated: the durable op_turns row short-circuits the
    // commit via the idempotent-replay guard — inserted=false, NO messages
    // appended (not the two the input carries). A duplicate transcript would
    // show two rows here.
    expect(out.inserted).toBe(false);
    expect(out.messages).toHaveLength(0);
    expect(readOpMessages(op.id).filter(m => m.turnIdx === 0)).toHaveLength(0);

    // NOTE ON DRIVE DEPTH: the idempotent re-drive is asserted at the commitTurn
    // level (the same level the existing EISDIR-seam tests use). It does NOT
    // re-run a full worker-loop recovery (recoverStaleOp + a fresh adapter
    // turn), which would re-drive turn N from the prior provider_state and land
    // a NEW op_turns/op_messages pair — that heavier path is a lease/recovery
    // concern proven in the recovery suite, not the commit-boundary invariant
    // under test here. What this pins is the boundary guarantee the reorder
    // exists to provide: a durable turn row + absent messages is a bounded,
    // non-terminal, replay-safe gap — never a false success, never a duplicate.
  });

  it("re-drive against an already-committed turn is the idempotent no-op path (no message duplication)", () => {
    // The idempotency guard (readOpTurn) must still short-circuit a replay:
    // op_turns present → append nothing, inserted=false. Preserved by the
    // reorder (the guard reads the SAME row the reorder now writes first).
    const op = mkOp("idempotent-redrive");
    writeOp(op);

    const first = commitTurn(commitInput(op));
    expect(first.inserted).toBe(true);
    const afterFirst = readOpMessages(op.id).filter(m => m.turnIdx === 0).length;

    const second = commitTurn(commitInput(readOp(op.id)!));
    expect(second.inserted).toBe(false);
    expect(second.messages).toHaveLength(0);

    const afterSecond = readOpMessages(op.id).filter(m => m.turnIdx === 0).length;
    expect(afterSecond).toBe(afterFirst);
  });
});
