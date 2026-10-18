// A restart empties the in-memory taint registry; an op recovered afterwards
// must taint its session again from what its rows persisted, or a replacement
// worker's egress runs clean against bytes the model already saw.
import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { appendOpMessage } from "./store.js";
import { opDir } from "../ops/event-log.js";
import { persistedTaintSources, restoreSessionTaintForOp } from "./recovery-taint.js";
import { checkEgressTaint, clearSessionTaint, getTaintSummary } from "../data-lineage/index.js";
import type { OpMessageRow } from "./types.js";
import type { Op } from "../ops/types.js";

let seq = 0;
const opIds: string[] = [];
function freshOpId(): string {
  const id = `op_recovery_taint_${process.pid}_${seq++}`;
  opIds.push(id);
  return id;
}

function toolRow(opId: string, n: number, metadata: unknown): OpMessageRow {
  return {
    messageId: `tr-${n}`, opId, turnIdx: 0, seqInTurn: n, role: "tool_result",
    content: { toolCallId: `c${n}`, result: "[error, exit_code=1]\ncat: permission denied", status: "error", metadata },
    createdAt: new Date(0).toISOString(),
  } as OpMessageRow;
}

afterEach(() => {
  while (opIds.length > 0) rmSync(opDir(opIds.pop()!), { recursive: true, force: true });
});

describe("a recovered op's session is tainted again from its rows", () => {
  it("replays every persisted (source, target) pair after the registry was emptied", () => {
    const opId = freshOpId();
    const sessionId = `s-${opId}`;
    appendOpMessage(toolRow(opId, 0, { exit_code: 1, taint_sources: [{ source: "sensitive_file", target: "/home/u/.ssh/id_rsa" }] }));
    appendOpMessage(toolRow(opId, 1, { exit_code: 1, taint_sources: [{ source: "secret", target: "STRIPE_KEY" }] }));
    expect(persistedTaintSources(opId)).toEqual([
      { source: "sensitive_file", target: "/home/u/.ssh/id_rsa" },
      { source: "secret", target: "STRIPE_KEY" },
    ]);

    // The restart: nothing in memory for this session.
    clearSessionTaint(sessionId);
    expect(getTaintSummary(sessionId).count).toBe(0);
    try {
      const op = { id: opId, canonical: { sessionId } } as unknown as Op;
      expect(restoreSessionTaintForOp(op)).toBe(2);
      expect(getTaintSummary(sessionId)).toEqual({ count: 2, sources: ["sensitive_file", "secret"] });
      expect(checkEgressTaint(sessionId).blocked).toBe(true);
    } finally {
      clearSessionTaint(sessionId);
    }
  });

  it("ignores rows without the key, malformed entries, and an op with no session", () => {
    const opId = freshOpId();
    appendOpMessage(toolRow(opId, 0, { exit_code: 0 }));
    appendOpMessage(toolRow(opId, 1, { taint_sources: "sensitive_file" }));
    appendOpMessage(toolRow(opId, 2, { taint_sources: [{ source: "not-a-source", target: "/x" }, { source: "web", target: "" }, null] }));
    expect(persistedTaintSources(opId)).toEqual([]);
    expect(restoreSessionTaintForOp({ id: opId, canonical: {} } as unknown as Op)).toBe(0);
  });
});
