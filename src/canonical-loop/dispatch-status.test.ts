/**
 * Regression: the dispatch boundary carries the tool-result envelope FLAVOR
 * instead of collapsing every failure to "error" (and it still maps `running`
 * to "ok" — the start succeeded, committedWork semantics unchanged).
 *
 * Seam under test (real functions, no mocks):
 *   renderToolResultForModel → parseStatusHeader → envelopeStatusToDispatchStatus
 * which is exactly the path chat-tool-dispatcher.ts takes for every dispatched
 * tool call. On pre-widening code the blocked/declined/timeout cases fail
 * (they came back "error").
 *
 * Plus: checkpoint persistence round-trip — an op_turns row with a widened
 * resultStatus survives insertOpTurn/readOpTurn intact, and a legacy row that
 * only knew ok|error|cancelled still loads.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  blocked,
  declined,
  timeout,
  running,
  ok,
  err,
  renderToolResultForModel,
  parseStatusHeader,
} from "../tools/result-helpers.js";
import { envelopeStatusToDispatchStatus } from "./tool-dispatch.js";
import { isDispatchFailure, type ToolCallSummary, type OpTurnRow } from "./types.js";
import { insertOpTurn, readOpTurn } from "./store.js";
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

/** The real render→parse→map pipeline the canonical dispatcher runs. */
function throughDispatchBoundary(result: Parameters<typeof renderToolResultForModel>[0]) {
  return envelopeStatusToDispatchStatus(parseStatusHeader(renderToolResultForModel(result)));
}

describe("dispatch boundary preserves envelope flavor", () => {
  it.each([
    ["blocked", blocked("Refused by policy.", { recovery: "use http_request" })],
    ["declined", declined("User said no to this call.")],
    ["timeout", timeout("Deadline expired.", { partial_output: "half done" })],
  ] as const)("%s arrives at dispatch with its flavor AND is not-ok for committedWork", (flavor, envelope) => {
    const status = throughDispatchBoundary(envelope);
    expect(status).toBe(flavor);
    // The committedWork invariant: every positive gate keys on === "ok", so a
    // widened failure must remain not-ok.
    expect(status === "ok").toBe(false);
    expect(isDispatchFailure(status)).toBe(true);
  });

  it("running still maps to ok (the START succeeded)", () => {
    expect(throughDispatchBoundary(running("sess-1", "started; poll process_status"))).toBe("ok");
  });

  it("ok and error map to themselves; legacy verbatim results stay ok", () => {
    expect(throughDispatchBoundary(ok("done", { duration_ms: 5 }))).toBe("ok");
    expect(throughDispatchBoundary(err("boom"))).toBe("error");
    // Legacy tool: bare content, no envelope — rendered verbatim, no header.
    expect(throughDispatchBoundary({ content: "plain output" })).toBe("ok");
  });

  it("cancelled is preserved in the union and is NOT a failure (never was)", () => {
    // Nothing produces "cancelled" at the envelope boundary today (the op
    // cancel path bails in dispatch-tools.ts before recording a summary);
    // the value is kept for op-cancel bookkeeping and must stay assignable.
    const summary: ToolCallSummary = { tool: "bash", argsHash: "0", resultStatus: "cancelled", durationMs: 1 };
    expect(isDispatchFailure(summary.resultStatus)).toBe(false);
    expect(isDispatchFailure("ok")).toBe(false);
    expect(isDispatchFailure(undefined)).toBe(false);
    expect(isDispatchFailure("error")).toBe(true);
  });
});

describe("checkpoint round-trip with widened statuses", () => {
  function turnRow(opId: string, summary: ToolCallSummary[]): OpTurnRow {
    return {
      opId,
      turnIdx: 0,
      providerState: { adapterName: "fake", adapterVersion: "1", providerPayload: null },
      toolCallSummary: summary,
      terminalReason: null,
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    };
  }

  it("persists blocked/declined/timeout resultStatus and reads them back intact", () => {
    const opId = newOpId("disp_status_rt");
    trackedIds.push(opId);
    const summary: ToolCallSummary[] = [
      { tool: "bash", argsHash: "a", resultStatus: "blocked", durationMs: 3 },
      { tool: "edit", argsHash: "b", resultStatus: "declined", durationMs: 4 },
      { tool: "web_fetch", argsHash: "c", resultStatus: "timeout", durationMs: 5 },
      { tool: "read", argsHash: "d", resultStatus: "ok", durationMs: 1 },
    ];
    expect(insertOpTurn(turnRow(opId, summary))).toBe(true);
    const back = readOpTurn(opId, 0);
    expect(back?.toolCallSummary.map(s => s.resultStatus)).toEqual(["blocked", "declined", "timeout", "ok"]);
  });

  it("legacy 3-state rows (old checkpoints) still load", () => {
    const opId = newOpId("disp_status_legacy");
    trackedIds.push(opId);
    const summary: ToolCallSummary[] = [
      { tool: "write", argsHash: "e", resultStatus: "error", durationMs: 2 },
      { tool: "bash", argsHash: "f", resultStatus: "cancelled", durationMs: 2 },
    ];
    expect(insertOpTurn(turnRow(opId, summary))).toBe(true);
    const back = readOpTurn(opId, 0);
    expect(back?.toolCallSummary.map(s => s.resultStatus)).toEqual(["error", "cancelled"]);
  });
});
