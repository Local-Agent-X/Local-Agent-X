/**
 * listLiveWorkers — the AGENTS sidebar's live set as one listing, for a client that
 * connected mid-job (chat-ws workers_list). It must list what the observer would
 * surface and describe it in the observer's own words.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";

// op-store binds its base dir from getLaxDir() at import, so the env override must
// be in place BEFORE the dynamic imports below.
const prevLaxDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-live-workers-"));
process.env.LAX_DATA_DIR = dataDir;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const { listLiveWorkers, turnProgressLine, suspendedWorkerStatus, suspensionLine } = await import("./live-workers.js");
const { writeOp } = await import("../ops/op-store.js");
const { OP_TYPE } = await import("../ops/op-types.js");

const mkOp = (id: string, type: string, canonical: Op["canonical"], extra: Partial<Op> = {}): Op => ({
  id,
  type,
  task: `task ${id}`,
  contextPack: {} as Op["contextPack"],
  lane: "build" as Op["lane"],
  retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
  ownerId: "u",
  visibility: "private" as Op["visibility"],
  status: "running" as Op["status"],
  createdAt: new Date().toISOString(),
  attemptCount: 0,
  canonical,
  ...extra,
});

describe("listLiveWorkers", () => {
  it("lists the session-submitted live ops the sidebar shows, with their status", () => {
    writeOp(mkOp("op_build", OP_TYPE.appBuild, { state: "running", flagValue: true, sessionId: "s1" },
      { startedAt: "2026-10-14T20:00:00.000Z", parentOpId: "op_parent" }));
    writeOp(mkOp("op_wait", OP_TYPE.appBuild, { state: "queued", flagValue: true, sessionId: "s1" }));
    writeOp(mkOp("op_blocked", OP_TYPE.appBuild, {
      state: "paused", flagValue: true, sessionId: "s2",
      suspension: { reason: "blocked", detail: "Waiting on approval: bash", suspendedAt: "2026-10-14T20:01:00.000Z" },
    }));
    writeOp(mkOp("op_headless", OP_TYPE.appBuild, { state: "running", flagValue: true }));
    writeOp(mkOp("op_chat", OP_TYPE.chatTurn, { state: "running", flagValue: true, sessionId: "s1" }));
    writeOp(mkOp("op_done", OP_TYPE.appBuild, { state: "succeeded", flagValue: true, sessionId: "s1" }));

    const byId = Object.fromEntries(listLiveWorkers().map((w) => [w.opId, w]));
    expect(Object.keys(byId).sort()).toEqual(["op_blocked", "op_build", "op_wait"]);
    expect(byId.op_build).toEqual({
      opId: "op_build", sessionId: "s1", task: "task op_build", status: "running",
      opType: OP_TYPE.appBuild, parentOpId: "op_parent", startedAt: "2026-10-14T20:00:00.000Z",
    });
    expect(byId.op_wait?.status).toBe("queued");
    expect(byId.op_blocked).toMatchObject({ status: "blocked", lastLine: "Waiting on approval: bash" });
  });
});

describe("the wording the observer streams live", () => {
  it("a turn reads as its tools, a failed one flagged, or thinking", () => {
    expect(turnProgressLine(3, [{ tool: "write", status: "ok" }, { tool: "bash", status: "error" }])).toBe("✓ turn 3 · write, bash ✗");
    expect(turnProgressLine(4, [])).toBe("✓ turn 4 · thinking");
  });

  it("a suspension reads as blocked, stalled, or paused", () => {
    const withReason = (reason: "blocked" | "stalled" | "user-paused") =>
      mkOp("x", OP_TYPE.appBuild, { state: "paused", flagValue: true, suspension: { reason, detail: "", suspendedAt: "" } });
    expect(suspendedWorkerStatus(withReason("blocked"))).toBe("blocked");
    expect(suspendedWorkerStatus(withReason("stalled"))).toBe("stalled");
    expect(suspendedWorkerStatus(withReason("user-paused"))).toBe("paused");
    expect(suspendedWorkerStatus(null)).toBe("paused");
  });

  // The stored detail is also the message streamed into the chat, which opens
  // with blank lines; a worker's first line showed only "…" on the phone.
  it("a suspension's line is its reason without the blank lines that open it", () => {
    const op = mkOp("x", OP_TYPE.appBuild, { state: "paused", flagValue: true, suspension: {
      reason: "blocked", detail: "\n\nSuspended: remember remained blocked after 5 attempts.", suspendedAt: "" } });
    expect(suspensionLine(op)).toBe("Suspended: remember remained blocked after 5 attempts.");
    expect(suspensionLine(null)).toBe("Operation paused");
  });
});
