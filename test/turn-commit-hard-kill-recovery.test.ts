import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { commitTurn, reconcilePublishedTurnCommitsForRecovery } from "../src/canonical-loop/checkpoint.js";
import { acquireLease } from "../src/canonical-loop/lease.js";
import { opTurnsDir } from "../src/canonical-loop/schema.js";
import { transitionOp } from "../src/canonical-loop/state-machine.js";
import { appendCanonicalEvent, readCanonicalEvents, readOpMessages, readOpTurn } from "../src/canonical-loop/store.js";
import { actionLogDir, readSessionActions } from "../src/ops/action-ledger.js";
import { readOp, writeOp } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";

const fixture = resolve("test/fixtures/turn-commit-hard-kill-worker.ts");
const tracked: Op[] = [];

afterAll(() => {
  for (const op of tracked) {
    rmSync(join(homedir(), ".lax", "operations", op.id), { recursive: true, force: true });
    rmSync(join(actionLogDir(), `${op.canonical!.sessionId}.jsonl`), { force: true });
  }
});

function seed(label: string): Op {
  const op: Op = {
    id: `op_hard_kill_${label}`, type: "freeform", task: label,
    contextPack: {} as Op["contextPack"], lane: "background",
    retryPolicy: { maxRecoveryAttempts: 2, backoffMs: [1] }, ownerId: "test",
    visibility: "private", status: "running", createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: { flagValue: true, state: "running", sessionId: `session-hard-kill-${label}` },
  };
  tracked.push(op);
  writeOp(op);
  return op;
}

async function publishThenKill(opId: string, mode = "published"): Promise<void> {
  await new Promise<void>((resolveExit, reject) => {
    const child = spawn(process.execPath, ["--import=tsx", fixture, opId, mode], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, LAX_DISABLE_BACKGROUND_JOBS: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let published = false;
    let stderr = "";
    child.stderr!.setEncoding("utf-8");
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.on("message", (message: { published?: boolean }) => {
      if (!message.published) return;
      published = true;
      child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.once("exit", () => published ? resolveExit() : reject(new Error(stderr || "child exited before publish")));
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_100));
}

function expireLease(opId: string): Op {
  const op = readOp(opId)!;
  op.canonical!.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
  writeOp(op);
  return readOp(opId)!;
}

function assertEvidence(op: Op): void {
  expect(readOpTurn(op.id, 0)?.turnIdx).toBe(0);
  expect(readOpMessages(op.id).filter((row) => row.turnIdx === 0)).toHaveLength(1);
  const events = readCanonicalEvents(op.id);
  expect(events.filter((event) => event.type === "turn_committed")).toHaveLength(1);
  expect(events.filter((event) => event.type === "message_appended")).toHaveLength(1);
  expect(readSessionActions(op.canonical!.sessionId!).filter((row) => row.opId === op.id)).toHaveLength(1);
}

describe("hard-kill recovery after envelope rename", () => {
  it("repairs evidence and terminal state after a child is killed before projection", async () => {
    const op = seed("terminal");
    await publishThenKill(op.id);
    expect(readCanonicalEvents(op.id).some((event) => event.type === "turn_committed")).toBe(false);
    expireLease(op.id);
    expect(reconcilePublishedTurnCommitsForRecovery(op.id)).toBe(true);
    assertEvidence(op);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
  });

  it.each(["paused", "cancelled", "approval", "failed"] as const)(
    "repairs non-state projections without overriding %s control",
    async (control) => {
      const op = seed(control);
      await publishThenKill(op.id);
      const current = expireLease(op.id);
      if (control === "paused") transitionOp(current, "paused", "user_pause");
      if (control === "cancelled") {
        transitionOp(current, "cancelling", "user_cancel");
        transitionOp(current, "cancelled", "user_cancelled");
      }
      if (control === "failed") transitionOp(current, "failed", "external_failure");
      if (control === "approval") {
        current.canonical!.pendingApproval = {
          approvalId: "approval-1", toolName: "write", argsPreview: "{}", requestedAt: Date.now(),
        };
        writeOp(current);
      }
      expect(reconcilePublishedTurnCommitsForRecovery(op.id)).toBe(true);
      assertEvidence(op);
      const state = readOp(op.id)?.canonical?.state;
      expect(state).toBe(control === "approval" ? "running" : control);
      expect(readCanonicalEvents(op.id).some((event) =>
        event.type === "state_changed" && event.body?.to === "succeeded")).toBe(false);
    },
  );

  it("repairs a JSONL tail left by a hard-killed writer without a sequence gap", async () => {
    const op = seed("partial-event");
    appendCanonicalEvent(op.id, "turn_started", { turnIdx: 0 });
    await publishThenKill(op.id, "partial-event");
    appendCanonicalEvent(op.id, "message_appended", { messageId: "m" });
    expect(readCanonicalEvents(op.id).map((event) => event.seq)).toEqual([0, 1]);
  });

  it("scavenges a hard-killed stage only after its writer is dead", async () => {
    const op = seed("dead-stage");
    await publishThenKill(op.id, "stage");
    expect(readOpTurn(op.id, 0)).toBeNull();
    expect(readdirSync(opTurnsDir(op.id)).filter((name) => name.endsWith(".stage"))).toHaveLength(1);
    expireLease(op.id);
    const replacement = acquireLease(op.id, "replacement-stage-worker");
    if (!replacement.ok) throw new Error(replacement.reason);
    expect(commitTurn({
      op: readOp(op.id)!, leaseClaim: replacement.claim, turnIdx: 0,
      providerState: { adapterName: "replacement", adapterVersion: "1", providerPayload: null },
      messages: [{ role: "assistant", content: "replacement" }],
      toolCallSummary: [], terminalReason: null,
    }).inserted).toBe(true);
    expect(readdirSync(opTurnsDir(op.id)).filter((name) => name.endsWith(".stage"))).toHaveLength(0);
  });
});
