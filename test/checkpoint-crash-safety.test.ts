import { afterEach, afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  _setTurnProjectionHookForTests,
  commitTurn,
  TurnCommitFenceError,
  type CommitTurnInput,
  type TurnProjectionPoint,
} from "../src/canonical-loop/checkpoint.js";
import { acquireLease, leaseClaimFromOp, type LeaseClaim } from "../src/canonical-loop/lease.js";
import { opMessagesPath, opTurnPath } from "../src/canonical-loop/schema.js";
import {
  appendOpMessage,
  insertOpTurn,
  readCanonicalEvents,
  readLatestOpTurn,
  readOpMessages,
  readOpTurn,
} from "../src/canonical-loop/store.js";
import {
  _setTurnCommitWriteHookForTests,
  readTurnArtifact,
  type TurnCommitWritePoint,
} from "../src/canonical-loop/turn-commit-store.js";
import { opDir } from "../src/ops/event-log.js";
import { newOpId, readOp, writeOp } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import { readSessionActions } from "../src/ops/action-ledger.js";
import type { OpMessageRow, OpTurnRow, ProviderStateEnvelope } from "../src/canonical-loop/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const trackedSessions = new Set<string>();
const PROVIDER_STATE: ProviderStateEnvelope = {
  adapterName: "fake",
  adapterVersion: "1",
  providerPayload: null,
};

function mkOp(label: string): { op: Op; claim: LeaseClaim } {
  const op: Op = {
    id: newOpId(`atomic_turn_${label}`),
    type: "freeform",
    task: `atomic turn ${label}`,
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "atomic-turn-test",
    visibility: "private",
    status: "running",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: { flagValue: true, state: "running", sessionId: `session-${label}` },
  };
  tracked.push(op.id);
  trackedSessions.add(op.canonical!.sessionId!);
  writeOp(op);
  const acquired = acquireLease(op.id, `worker-${label}`);
  if (!acquired.ok) throw new Error(`test lease failed: ${acquired.reason}`);
  return { op: readOp(op.id)!, claim: acquired.claim };
}

function input(op: Op, claim: LeaseClaim, over: Partial<CommitTurnInput> = {}): CommitTurnInput {
  const turnIdx = over.turnIdx ?? 0;
  return {
    op,
    leaseClaim: claim,
    turnIdx,
    providerState: PROVIDER_STATE,
    messages: [
      { messageId: `${op.id}-${turnIdx}-a`, role: "assistant", content: "reply-a" },
      { messageId: `${op.id}-${turnIdx}-b`, role: "tool_result", content: "reply-b" },
    ],
    toolCallSummary: [],
    terminalReason: null,
    ...over,
  };
}

function turnRow(opId: string, turnIdx = 0): OpTurnRow {
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

function messageRow(opId: string, turnIdx = 0): OpMessageRow {
  return {
    messageId: `${opId}-legacy-message`,
    opId,
    turnIdx,
    seqInTurn: 0,
    role: "assistant",
    content: "legacy",
    createdAt: new Date().toISOString(),
  };
}

afterEach(() => {
  _setTurnCommitWriteHookForTests(null);
  _setTurnProjectionHookForTests(null);
});
afterAll(() => {
  for (const id of tracked) rmSync(join(OPS_BASE, id), { recursive: true, force: true });
  for (const sessionId of trackedSessions) {
    rmSync(join(homedir(), ".lax", "action-log", `${sessionId}.jsonl`), { force: true });
  }
});

describe("turn commit visibility boundary", () => {
  const beforePublish: TurnCommitWritePoint[] = [
    "before_stage_open",
    "after_stage_write",
    "after_stage_fsync",
    "before_publish",
  ];

  for (const point of beforePublish) {
    it(`keeps the entire finalized turn invisible after a crash at ${point}`, () => {
      const { op, claim } = mkOp(point);
      appendOpMessage({ ...messageRow(op.id), role: "user", content: "request" });
      _setTurnCommitWriteHookForTests((seen) => {
        if (seen === point) throw new Error(`crash:${point}`);
      });

      expect(() => commitTurn(input(op, claim))).toThrow(`crash:${point}`);
      expect(readOpTurn(op.id, 0)).toBeNull();
      expect(readOpMessages(op.id).map((row) => row.role)).toEqual(["user"]);
      expect(readCanonicalEvents(op.id).some((event) => event.type === "turn_committed")).toBe(false);
    });
  }

  it("exposes turn and finalized messages together after publish and repairs projections idempotently", () => {
    const { op, claim } = mkOp("after-publish");
    const commit = input(op, claim, {
      toolCallSummary: [{ tool: "read", argsHash: "hash", resultStatus: "ok", durationMs: 1 }],
    });
    _setTurnCommitWriteHookForTests((point) => {
      if (point === "after_publish") throw new Error("crash:after_publish");
    });
    expect(() => commitTurn(commit)).toThrow("crash:after_publish");
    expect(readOpTurn(op.id, 0)?.turnIdx).toBe(0);
    expect(readOpMessages(op.id).filter((row) => row.turnIdx === 0)).toHaveLength(2);
    expect(readCanonicalEvents(op.id).some((event) => event.type === "turn_committed")).toBe(false);

    _setTurnCommitWriteHookForTests(null);
    const replay = commitTurn({ ...commit, op: readOp(op.id)! });
    expect(replay.inserted).toBe(false);
    expect(readOpMessages(op.id).filter((row) => row.turnIdx === 0)).toHaveLength(2);
    expect(readCanonicalEvents(op.id).filter((event) => event.type === "turn_committed")).toHaveLength(1);
    expect(readCanonicalEvents(op.id).filter((event) => event.type === "message_appended")).toHaveLength(2);
    commitTurn({ ...commit, op: readOp(op.id)! });
    expect(readSessionActions("session-after-publish").filter((row) =>
      row.opId === op.id && row.turnIdx === 0)).toHaveLength(1);
  });

  it("publishes a terminal turn before projecting its terminal state", () => {
    const { op, claim } = mkOp("terminal");
    const result = commitTurn(input(op, claim, { terminalReason: "done" }));
    expect(result.inserted).toBe(true);
    expect(readOpTurn(op.id, 0)?.terminalReason).toBe("done");
    expect(readOpMessages(op.id).filter((row) => row.turnIdx === 0)).toHaveLength(2);
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
  });

  it("commits legacy provider-exact rows without a target and omits routing feedback", () => {
    const { op, claim } = mkOp("legacy-runtime-target");
    op.runtimeDescriptor = {
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "openai",
      credentialProvider: "openai",
      authSource: "env",
      model: "legacy-model",
      runtime: "openai-compat",
      integrity: { scheme: "hmac-sha256-v1", mac: "f".repeat(64) },
    } as unknown as Op["runtimeDescriptor"];
    writeOp(op);

    expect(() => commitTurn(input(op, claim, {
      terminalReason: "done",
      learnedOutcome: "clean",
    }))).not.toThrow();
    const artifact = readTurnArtifact(op.id, 0);
    expect(artifact && "turn" in artifact ? artifact.projection.routingFeedback : undefined)
      .toBeUndefined();
    expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
  });

  const projectionPoints: TurnProjectionPoint[] = [
    "before_checkpoint",
    "after_checkpoint",
    "after_message_events",
    "after_turn_event",
    "after_action_ledger",
    "before_terminal",
    "after_terminal",
  ];

  for (const point of projectionPoints) {
    it(`repairs every projection exactly once after a crash at ${point}`, () => {
      const { op, claim } = mkOp(`projection-${point}`);
      const commit = input(op, claim, {
        terminalReason: "done",
        toolCallSummary: [{ tool: "read", argsHash: "hash", resultStatus: "ok", durationMs: 1 }],
      });
      _setTurnProjectionHookForTests((seen) => {
        if (seen === point) throw new Error(`crash:${point}`);
      });
      expect(() => commitTurn(commit)).toThrow(`crash:${point}`);
      expect(readOpTurn(op.id, 0)?.turnIdx).toBe(0);
      expect(readOpMessages(op.id).filter((row) => row.turnIdx === 0)).toHaveLength(2);

      _setTurnProjectionHookForTests(null);
      commitTurn({ ...commit, op: readOp(op.id)! });
      const events = readCanonicalEvents(op.id);
      expect(events.filter((event) => event.type === "message_appended")).toHaveLength(2);
      expect(events.filter((event) => event.type === "turn_committed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "state_changed"
        && event.body?.to === "succeeded")).toHaveLength(1);
      expect(readSessionActions(op.canonical!.sessionId!).filter((row) =>
        row.opId === op.id && row.turnIdx === 0)).toHaveLength(1);
      expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
    });
  }
});

describe("turn commit lease fencing", () => {
  it("rejects an old generation after takeover without any turn, message, event, or state mutation", () => {
    const { op, claim: oldClaim } = mkOp("stale");
    const expired = readOp(op.id)!;
    expired.canonical!.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    writeOp(expired);
    const replacement = acquireLease(op.id, "replacement-worker");
    expect(replacement.ok).toBe(true);
    const before = readOp(op.id)!;

    expect(() => commitTurn(input(op, oldClaim))).toThrow(TurnCommitFenceError);
    expect(readOpTurn(op.id, 0)).toBeNull();
    expect(readOpMessages(op.id)).toEqual([]);
    expect(readCanonicalEvents(op.id)).toEqual([]);
    expect(readOp(op.id)).toEqual(before);
  });

  it("requires an exact persisted claim rather than owner name alone", () => {
    const { op, claim } = mkOp("generation");
    expect(leaseClaimFromOp(readOp(op.id))).toEqual(claim);
    expect(() => commitTurn(input(op, { owner: claim.owner, generation: claim.generation + 1 })))
      .toThrow(TurnCommitFenceError);
    expect(readOpTurn(op.id, 0)).toBeNull();
  });
});

describe("legacy and incomplete artifacts", () => {
  it("preserves a complete legacy turn plus message artifact", () => {
    const { op } = mkOp("legacy");
    insertOpTurn(turnRow(op.id));
    appendOpMessage(messageRow(op.id));
    expect(readOpTurn(op.id, 0)?.providerState.adapterName).toBe("fake");
    expect(readOpMessages(op.id).map((row) => row.content)).toEqual(["legacy"]);
  });

  it("ignores an incomplete staged successor without losing the older committed turn", () => {
    const { op, claim } = mkOp("stage-ignore");
    commitTurn(input(op, claim));
    const staged = `${opTurnPath(op.id, 1)}.dead.stage`;
    mkdirSync(join(opDir(op.id), "op-turns"), { recursive: true });
    writeFileSync(staged, "{\"schemaVersion\":1", "utf-8");
    expect(readOpTurn(op.id, 0)?.turnIdx).toBe(0);
    expect(readOpTurn(op.id, 1)).toBeNull();
    expect(readOpMessages(op.id).filter((row) => row.turnIdx === 0)).toHaveLength(2);
    expect(existsSync(staged)).toBe(true);
  });

  it("skips a malformed final artifact, preserves the older turn, and re-drives the corrupt index", () => {
    const { op, claim } = mkOp("corrupt-final");
    commitTurn(input(op, claim));
    writeFileSync(opTurnPath(op.id, 1), "{\"schemaVersion\":1", "utf-8");
    expect(readLatestOpTurn(op.id)?.turnIdx).toBe(0);

    const repaired = commitTurn(input(readOp(op.id)!, claim, { turnIdx: 1 }));
    expect(repaired.inserted).toBe(true);
    expect(readLatestOpTurn(op.id)?.turnIdx).toBe(1);
    expect(readOpMessages(op.id).filter((row) => row.turnIdx === 1)).toHaveLength(2);
  });

  it("still surfaces low-level writer failures distinctly from idempotency", () => {
    const { op } = mkOp("low-level");
    const messagePath = opMessagesPath(op.id);
    mkdirSync(messagePath, { recursive: true });
    expect(() => appendOpMessage(messageRow(op.id))).toThrow();
    rmSync(messagePath, { recursive: true, force: true });
    expect(insertOpTurn(turnRow(op.id))).toBe(true);
    expect(insertOpTurn(turnRow(op.id))).toBe(false);
  });
});
