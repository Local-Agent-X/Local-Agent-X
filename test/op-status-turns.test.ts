import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeOp, newOpId } from "../src/ops/op-store.js";
import { insertOpTurn } from "../src/canonical-loop/store.js";
import { opStatusTool } from "../src/ops/tools/op-status.js";
import type { Op } from "../src/ops/types.js";
import type { OpTurnRow } from "../src/canonical-loop/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const createdIds: string[] = [];

afterEach(() => {
  for (const id of createdIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  createdIds.length = 0;
});

const mkOp = (id: string): Op => ({
  id,
  type: "app-build",
  task: 'Build app "scandal-tracker"',
  contextPack: {} as Op["contextPack"],
  lane: "build",
  retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
  ownerId: "u",
  visibility: "private",
  status: "running",
  createdAt: new Date().toISOString(),
  attemptCount: 1,
});

const mkTurn = (opId: string, turnIdx: number, tools: Array<[string, "ok" | "error"]>): OpTurnRow => ({
  opId,
  turnIdx,
  providerState: { adapterName: "test", adapterVersion: "1", providerPayload: null },
  toolCallSummary: tools.map(([tool, resultStatus]) => ({ tool, argsHash: "h", resultStatus, durationMs: 1 })),
  terminalReason: null,
  redirectConsumed: false,
  createdAt: new Date().toISOString(),
});

describe("op_status — canonical turn activity", () => {
  it("surfaces per-turn tool activity for a canonical-loop op", async () => {
    const id = newOpId("op_app-build");
    createdIds.push(id);
    writeOp(mkOp(id));
    insertOpTurn(mkTurn(id, 0, [["read", "ok"], ["read", "ok"]]));
    insertOpTurn(mkTurn(id, 1, [["edit", "ok"]]));
    insertOpTurn(mkTurn(id, 2, [["write", "error"]]));

    const res = await opStatusTool.execute({ op_id: id, _sessionId: "sess-turns" });

    expect(res.content).toContain("recent turns (3 total)");
    expect(res.content).toContain("turn 0: read, read");
    expect(res.content).toContain("turn 1: edit");
    expect(res.content).toContain("turn 2: write (error)");
  });

  it("renders a turn with no tool calls as thinking", async () => {
    const id = newOpId("op_app-build");
    createdIds.push(id);
    writeOp(mkOp(id));
    insertOpTurn(mkTurn(id, 0, []));

    const res = await opStatusTool.execute({ op_id: id, _sessionId: "sess-thinking" });

    expect(res.content).toContain("turn 0: thinking");
  });

  it("reports no activity when an op has no turns yet", async () => {
    const id = newOpId("op_app-build");
    createdIds.push(id);
    writeOp(mkOp(id));

    const res = await opStatusTool.execute({ op_id: id, _sessionId: "sess-empty" });

    expect(res.content).toContain("no turn activity recorded yet");
  });
});
