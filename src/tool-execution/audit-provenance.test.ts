// Provenance recording at the canonical audit seam (audit-tool-call.ts).
//
// Invariants under test: a SUCCESSFUL (statusOf === "ok") create-class call
// that declares `args.sources` lands exactly ONE record in the deliverable's
// sidecar, carrying the call's identity (toolCallId / sessionId / opId) and
// the target resolved by the shared createTargetPath mapping; error and
// blocked results record nothing (including a result evaluateThreat itself
// flips to blocked — recording must sit AFTER the threat gate); the 99%
// no-sources path creates no sidecar at all; malformed `sources` (string /
// object / empty array) record nothing; a collapsed-family call (spreadsheet
// write) records its `action`; and a result satisfied WITHOUT executing in
// this invocation — side-effect-journal replay of a crash-recovery
// re-dispatch, or a dedup-cache reuse — never adds a second record.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditPhase } from "./audit-tool-call.js";
import { dedupCheckPhase } from "./dedup-check.js";
import { dedupRecord, _clearDedupCacheForTests } from "./dedup-cache.js";
import { runSandboxedPhase } from "./run-sandboxed.js";
import { opDir } from "../ops/event-log.js";
import type { ToolCallContext } from "./context.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { readProvenance } from "../data-lineage/provenance.js";

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.LAX_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "lax-audit-prov-"));
  process.env.LAX_DATA_DIR = dir;
  _clearDedupCacheForTests();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  _clearDedupCacheForTests();
});

// Minimal audit-phase ctx, same posture as budget-error-results.test.ts —
// no hooks / events, threat engine only where a test injects one, so the
// phase's other duties are inert.
function makeCtx(over: {
  tool?: string;
  args?: Record<string, unknown>;
  result?: ToolResult;
  sessionId?: string | undefined;
  threatEngine?: unknown;
}): ToolCallContext {
  return {
    tc: { id: "call_prov_1", name: over.tool ?? "write", arguments: JSON.stringify(over.args ?? {}) },
    args: over.args ?? {},
    sessionId: "sessionId" in over ? over.sessionId : "prov-sess-1",
    operationId: "op_prov_1",
    callContext: "local",
    allowed: true,
    msgs: [],
    result: over.result ?? { content: "written", status: "ok" },
    threatEngine: over.threatEngine,
  } as unknown as ToolCallContext;
}

function sidecarDirExists(): boolean {
  return existsSync(join(dir, "provenance"));
}

describe("auditPhase provenance recording", () => {
  it("records exactly one attributed record for an ok write with sources", async () => {
    const target = join(dir, "deliverable.md");
    const ctx = makeCtx({
      args: {
        path: target,
        sources: [{ url: "https://example.com/report", note: "headline figure" }],
      },
    });
    await auditPhase(ctx);

    const rows = readProvenance(target);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolCallId).toBe("call_prov_1");
    expect(rows[0].sessionId).toBe("prov-sess-1");
    expect(rows[0].opId).toBe("op_prov_1");
    expect(rows[0].tool).toBe("write");
    expect(rows[0].file.endsWith("deliverable.md")).toBe(true);
    expect(rows[0].sources).toEqual([{ url: "https://example.com/report", note: "headline figure" }]);
    // The phase's normal duty is intact: the tool message still lands.
    expect(ctx.msgs).toHaveLength(1);
  });

  it("records nothing for error or blocked results", async () => {
    const target = join(dir, "deliverable.md");
    const sources = [{ url: "https://example.com/report" }];
    await auditPhase(makeCtx({
      args: { path: target, sources },
      result: { content: "boom", isError: true, status: "error" },
    }));
    await auditPhase(makeCtx({
      args: { path: target, sources },
      result: { content: "BLOCKED by threat engine", isError: true, status: "blocked" },
    }));
    expect(readProvenance(target)).toEqual([]);
    expect(sidecarDirExists()).toBe(false);
  });

  it("creates no sidecar file anywhere when sources are absent", async () => {
    await auditPhase(makeCtx({ args: { path: join(dir, "deliverable.md") } }));
    expect(sidecarDirExists()).toBe(false);
  });

  it("records nothing for malformed sources (string / object / empty array)", async () => {
    const target = join(dir, "deliverable.md");
    for (const sources of ["https://example.com/report", { url: "https://example.com" }, []]) {
      await auditPhase(makeCtx({ args: { path: target, sources } }));
    }
    expect(readProvenance(target)).toEqual([]);
    expect(sidecarDirExists()).toBe(false);
  });

  it("records nothing when the call carries no create-class file target", async () => {
    // web_search has no target mapping; spreadsheet `read` maps to none.
    await auditPhase(makeCtx({
      tool: "web_search",
      args: { query: "q", sources: [{ url: "https://example.com" }] },
    }));
    await auditPhase(makeCtx({
      tool: "spreadsheet",
      args: { action: "read", file_path: join(dir, "book.xlsx"), sources: [{ url: "https://example.com" }] },
    }));
    expect(sidecarDirExists()).toBe(false);
  });

  it("carries the action for a collapsed-family spreadsheet write", async () => {
    const target = join(dir, "report.xlsx");
    await auditPhase(makeCtx({
      tool: "spreadsheet",
      args: { action: "write", file_path: target, sources: [{ file: "/etc/hosts", ref: "L1-10" }] },
    }));
    const rows = readProvenance(target);
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("spreadsheet");
    expect(rows[0].action).toBe("write");
    expect(rows[0].file.endsWith("report.xlsx")).toBe(true);
    expect(rows[0].sources).toEqual([{ file: "/etc/hosts", ref: "L1-10" }]);
  });

  it("records nothing for a sessionless dispatch (no identity to attribute)", async () => {
    await auditPhase(makeCtx({
      sessionId: undefined,
      args: { path: join(dir, "deliverable.md"), sources: [{ url: "https://example.com" }] },
    }));
    expect(sidecarDirExists()).toBe(false);
  });

  it("records nothing when evaluateThreat itself flips an ok result to blocked", async () => {
    // Ordering regression: the result enters the phase as "ok" and is flipped
    // by the threat gate INSIDE auditPhase — if recording ever moved before
    // evaluateThreat, this would land a record and fail.
    const target = join(dir, "deliverable.md");
    const ctx = makeCtx({
      args: { path: target, sources: [{ url: "https://example.com/report" }] },
      threatEngine: {
        evaluateToolResult: () => ({ blocked: true, reason: "declared-source exfil probe" }),
        isRestricted: () => false,
      },
    });
    await auditPhase(ctx);
    expect(ctx.result!.status).toBe("blocked"); // the flip really happened
    expect(readProvenance(target)).toEqual([]);
    expect(sidecarDirExists()).toBe(false);
  });
});

describe("auditPhase provenance — suppressed executions record nothing", () => {
  it("dedup-cache reuse adds no record for a write that did not execute now", async () => {
    // F2 regression: the office create-class families (spreadsheet et al.,
    // unlike `write`) are NOT in DEDUP_SKIP, so a duplicated create within
    // the TTL reuses the cached ok result and the dedup-position auditPhase
    // re-runs in full. The reused result still reads "ok" — only the dedup
    // phase knows nothing executed.
    const target = join(dir, "report.xlsx");
    const args = { action: "write", file_path: target, sources: [{ url: "https://example.com/report" }] };
    const session = "prov-dedup-sess";
    const ctx = makeCtx({ tool: "spreadsheet", sessionId: session, args });
    dedupRecord(session, "spreadsheet", ctx.tc.arguments, {
      msgs: [{ role: "tool", tool_call_id: "call_orig", content: "written" }],
      allowed: true,
      result: { content: "written", status: "ok" },
      resultContent: "written",
    });
    const outcome = await dedupCheckPhase(ctx);
    expect(outcome.kind).toBe("halt"); // a genuine reuse, not a miss
    await auditPhase(ctx);
    expect(readProvenance(target)).toEqual([]);
    expect(sidecarDirExists()).toBe(false);
  });

  it("journal replay re-dispatch keeps exactly one record for the toolCallId", async () => {
    // F1 regression: a crash after auditPhase but before the op checkpoint
    // re-dispatches the same (opId, toolCallId); the side-effect journal
    // replays the completed entry's ok result WITHOUT executing, the full
    // auditPhase re-runs, and the sidecar (no idempotency key) must not gain
    // a second record for the same write.
    const target = join(dir, "deliverable.md");
    const operationId = `op_prov_replay_${process.pid}_${Date.now()}`;
    let executions = 0;
    const tool: ToolDefinition = {
      name: "write",
      description: "provenance replay probe",
      parameters: { type: "object" },
      effect: { class: "non-idempotent" },
      execute: async () => { executions++; return { content: "written", status: "ok" }; },
    } as unknown as ToolDefinition;
    const args = { path: target, sources: [{ url: "https://example.com/report" }] };
    const dispatch = () => ({
      ...makeCtx({ args: { ...args }, sessionId: "prov-replay-sess" }),
      tc: { id: "call_replay_1", name: "write", arguments: JSON.stringify(args) },
      tool,
      toolMap: new Map([[tool.name, tool]]),
      operationId,
      result: undefined,
      riskLevel: "low",
      approvalContext: "",
    }) as unknown as ToolCallContext;
    try {
      const first = dispatch();
      await runSandboxedPhase(first);
      await auditPhase(first);
      expect(executions).toBe(1);
      expect(readProvenance(target)).toHaveLength(1);

      const second = dispatch(); // crash-recovery re-dispatch, same identity
      await runSandboxedPhase(second);
      await auditPhase(second);
      expect(executions).toBe(1); // replayed, never re-executed
      expect(second.result!.content).toBe("written"); // prior ok result reused

      const rows = readProvenance(target);
      expect(rows).toHaveLength(1); // still exactly one for this toolCallId
      expect(rows[0].toolCallId).toBe("call_replay_1");
    } finally {
      rmSync(opDir(operationId), { recursive: true, force: true });
    }
  });
});
