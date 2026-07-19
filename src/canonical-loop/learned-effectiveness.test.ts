import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import type { Op } from "../ops/types.js";
import { readOp, writeOp } from "../ops/op-store.js";
import {
  _setLearnedEffectivenessWriteHookForTests,
  prepareLearnedOutcome,
  type LearnedOutcome,
  type LearnedOutcomeReceipt,
} from "../protocols/learned-effectiveness.js";
import {
  getLearnedProtocolEnvelopeForOp,
  clearLearnedProtocolEnvelopeForOp,
  registerLearnedProtocolEnvelopeForOp,
  resetCanonicalRuntime,
} from "./runtime.js";
import { _setBeforePersistHookForTests, transitionOp } from "./state-machine.js";
import {
  _setCanonicalLearningOutcomeRecorderForTests,
  reconcileCanonicalLearnedOutcomes,
} from "./learned-effectiveness.js";
import { getLaxDir } from "../lax-data-dir.js";
import { clearExternalIngestion, recordExternalIngestion } from "../data-lineage/external.js";
import { clearSessionTaint, recordSensitiveRead } from "../data-lineage/taint.js";
import { insertOpTurn } from "./store.js";
import type { OpTurnRow } from "./types.js";

const ORIGINAL_CONFIG = getRuntimeConfig();
let workspaceRoot = "";
const opIds = new Set<string>();
let sequence = 0;
const learningRecorder = vi.fn();

function op(outcome: string): Op {
  const id = `learned-feedback-${outcome}-${Date.now()}-${++sequence}`;
  opIds.add(id);
  return {
    id, type: "freeform", task: outcome, lane: "interactive",
    contextPack: {} as Op["contextPack"],
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [] },
    ownerId: "learned-feedback-test", visibility: "private", status: "running",
    createdAt: new Date().toISOString(), attemptCount: 0,
    canonical: { flagValue: true, state: "running" },
  } as Op;
}

function receiptPath(opId: string): string {
  const hash = createHash("sha256").update(opId).digest("hex");
  return join(getRuntimeConfig().workspace, "protocols", "effectiveness", "outcomes", `${hash}.json`);
}

function envelope(opId: string): void {
  registerLearnedProtocolEnvelopeForOp(opId, {
    slug: "learned-0123456789abcdefabcd",
    versionId: "12345678-1234-1234-1234-123456789abc",
    candidateId: "learned-0123456789abcdefabcd",
    allowedTools: ["read"],
  });
}

function readReceipt(opId: string): LearnedOutcomeReceipt {
  return JSON.parse(readFileSync(receiptPath(opId), "utf8")) as LearnedOutcomeReceipt;
}

function learning(learnedOutcome: LearnedOutcome, learningSessionId = "trusted-learning-session") {
  return { learnedOutcome, learningSessionId };
}

function observeNativeTool(opId: string, tool: string): void {
  insertOpTurn({
    opId, turnIdx: 0,
    providerState: { adapterName: "anthropic", adapterVersion: "1", providerPayload: {} },
    toolCallSummary: [], observedTools: [tool], terminalReason: null,
    redirectConsumed: false, createdAt: new Date().toISOString(),
  } as OpTurnRow);
}

beforeAll(() => { workspaceRoot = mkdtempSync(join(tmpdir(), "lax-learned-feedback-")); });
beforeEach(() => {
  setRuntimeConfig({ ...ORIGINAL_CONFIG, workspace: mkdtempSync(join(workspaceRoot, "case-")) } as LAXConfig);
  learningRecorder.mockReset();
  _setCanonicalLearningOutcomeRecorderForTests(learningRecorder);
});
afterEach(() => {
  _setLearnedEffectivenessWriteHookForTests();
  _setBeforePersistHookForTests();
  resetCanonicalRuntime();
  _setCanonicalLearningOutcomeRecorderForTests();
  clearExternalIngestion("external-learning-session");
  clearSessionTaint("sensitive-learning-session");
  for (const id of opIds) {
    const dir = join(getLaxDir(), "operations", id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  opIds.clear();
  rmSync(getRuntimeConfig().workspace, { recursive: true, force: true });
});
afterAll(() => {
  setRuntimeConfig(ORIGINAL_CONFIG);
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("canonical learned effectiveness integration", () => {
  it.each([
    ["turn_done", "succeeded", "clean"],
    ["iteration_checkpoint", "succeeded", "partial"],
    ["deadline_exceeded", "failed", "aborted"],
    ["max_tokens_exceeded", "failed", "aborted"],
    ["worker_exception", "failed", "aborted"],
  ] as const)("records %s with exact provenance", (reason, state, outcome) => {
    const current = op(reason);
    envelope(current.id);
    transitionOp(current, state, reason, learning(outcome));

    expect(readReceipt(current.id)).toMatchObject({
      status: "committed", opId: current.id, outcome,
      slug: "learned-0123456789abcdefabcd",
      versionId: "12345678-1234-1234-1234-123456789abc",
      candidateId: "learned-0123456789abcdefabcd",
    });
    expect(getLearnedProtocolEnvelopeForOp(current.id)).toBeNull();
    expect(learningRecorder).toHaveBeenCalledTimes(1);
    expect(learningRecorder).toHaveBeenCalledWith(current, outcome, "trusted-learning-session", expect.any(Number));
  });

  it("does not score a user cancellation as learned-protocol failure", () => {
    const current = op("cancelled");
    current.canonical!.state = "cancelling";
    envelope(current.id);
    transitionOp(current, "cancelled", "adapter_aborted");
    expect(existsSync(receiptPath(current.id))).toBe(false);
    expect(getLearnedProtocolEnvelopeForOp(current.id)).toBeNull();
    expect(learningRecorder).not.toHaveBeenCalled();
  });

  it("writes pending before terminal persistence and committed only after it", () => {
    const current = op("ordering");
    writeOp(current);
    envelope(current.id);
    const observed: Array<{ status: string; state: string | undefined }> = [];
    _setLearnedEffectivenessWriteHookForTests((_phase, receipt) => {
      observed.push({ status: receipt.status, state: readOp(current.id)?.canonical?.state });
    });

    transitionOp(current, "succeeded", "turn_done", learning("clean"));

    expect(observed).toEqual([
      { status: "pending", state: "running" },
      { status: "committed", state: "succeeded" },
    ]);
  });

  it("keeps and resumes a pending receipt when terminal persistence is interrupted", () => {
    const current = op("persist-throws");
    writeOp(current);
    envelope(current.id);
    _setLearnedEffectivenessWriteHookForTests((_phase, receipt) => {
      if (receipt.status === "pending") {
        _setBeforePersistHookForTests(() => { throw new Error("injected terminal persistence failure"); });
      }
    });
    expect(() => transitionOp(current, "succeeded", "turn_done", learning("clean")))
      .toThrow("injected terminal persistence failure");
    expect(readReceipt(current.id).status).toBe("pending");
    expect(readOp(current.id)?.canonical?.state).toBe("running");
    expect(learningRecorder).not.toHaveBeenCalled();
    _setLearnedEffectivenessWriteHookForTests();
    _setBeforePersistHookForTests();
    resetCanonicalRuntime();
    transitionOp(readOp(current.id)!, "succeeded", "turn_done", learning("clean"));
    expect(readReceipt(current.id).status).toBe("committed");
    expect(learningRecorder).toHaveBeenCalledTimes(1);
  });

  it("keeps pending C7 but preserves committed C1 when effectiveness commit fails", () => {
    const current = op("effectiveness-commit-throws");
    writeOp(current);
    envelope(current.id);
    _setLearnedEffectivenessWriteHookForTests((_phase, receipt) => {
      if (receipt.status === "committed") throw new Error("injected effectiveness failure");
    });

    expect(() => transitionOp(current, "failed", "worker_exception", learning("aborted"))).not.toThrow();

    expect(readOp(current.id)?.canonical?.state).toBe("failed");
    expect(readReceipt(current.id).status).toBe("pending");
    expect(learningRecorder).toHaveBeenCalledTimes(1);
    expect(learningRecorder).toHaveBeenCalledWith(current, "aborted", "trusted-learning-session", expect.any(Number));
  });

  it("does not commit stale clean C7 when a retry ends aborted", () => {
    const current = op("changed-outcome");
    writeOp(current);
    envelope(current.id);
    _setLearnedEffectivenessWriteHookForTests((_phase, receipt) => {
      if (receipt.status === "pending") {
        _setBeforePersistHookForTests(() => { throw new Error("injected terminal persistence failure"); });
      }
    });
    expect(() => transitionOp(current, "succeeded", "turn_done", learning("clean")))
      .toThrow("injected terminal persistence failure");
    expect(readReceipt(current.id)).toMatchObject({ status: "pending", outcome: "clean" });
    clearLearnedProtocolEnvelopeForOp(current.id);
    _setLearnedEffectivenessWriteHookForTests();
    _setBeforePersistHookForTests();

    transitionOp(readOp(current.id)!, "failed", "worker_exception", learning("aborted"));

    expect(readOp(current.id)?.canonical?.state).toBe("failed");
    expect(readReceipt(current.id)).toMatchObject({ status: "pending", outcome: "clean" });
    expect(learningRecorder).toHaveBeenCalledTimes(1);
    expect(reconcileCanonicalLearnedOutcomes(learningRecorder).quarantined).toHaveLength(1);
  });

  it("keeps a selected workflow terminal but excludes unknown-session evidence", () => {
    const current = op("unknown-session");
    envelope(current.id);

    transitionOp(current, "succeeded", "turn_done", { learnedOutcome: "clean" });

    expect(current.canonical?.state).toBe("succeeded");
    expect(existsSync(receiptPath(current.id))).toBe(false);
    expect(learningRecorder).not.toHaveBeenCalled();
  });

  it("keeps a selected workflow terminal but excludes external-ingestion evidence", () => {
    const current = op("external-session");
    envelope(current.id);
    recordExternalIngestion("external-learning-session");

    transitionOp(current, "succeeded", "turn_done", learning("clean", "external-learning-session"));

    expect(current.canonical?.state).toBe("succeeded");
    expect(existsSync(receiptPath(current.id))).toBe(false);
    expect(learningRecorder).not.toHaveBeenCalled();
  });

  it("keeps a selected workflow terminal but excludes sensitive-taint evidence", () => {
    const current = op("sensitive-session");
    envelope(current.id);
    recordSensitiveRead("sensitive-learning-session", "sensitive_file", ".env", "secret material long enough");

    transitionOp(current, "succeeded", "turn_done", learning("clean", "sensitive-learning-session"));

    expect(current.canonical?.state).toBe("succeeded");
    expect(existsSync(receiptPath(current.id))).toBe(false);
    expect(learningRecorder).not.toHaveBeenCalled();
  });

  it("keeps a selected workflow terminal but excludes native external-tool evidence", () => {
    const current = op("native-search");
    envelope(current.id);
    observeNativeTool(current.id, "WebSearch");

    transitionOp(current, "succeeded", "turn_done", learning("clean", "native-search-session"));

    expect(current.canonical?.state).toBe("succeeded");
    expect(existsSync(receiptPath(current.id))).toBe(false);
    expect(learningRecorder).not.toHaveBeenCalled();
  });

  it("records ordinary learning evidence without creating an effectiveness receipt", () => {
    const current = op("ordinary");
    transitionOp(current, "succeeded", "turn_done", learning("clean"));
    expect(existsSync(receiptPath(current.id))).toBe(false);
    expect(learningRecorder).toHaveBeenCalledTimes(1);
    expect(learningRecorder).toHaveBeenCalledWith(current, "clean", "trusted-learning-session", undefined);
  });

  it("reconciles restart-pending work and replays the learner idempotently", () => {
    const current = op("restart");
    current.canonical!.state = "succeeded";
    current.status = "completed";
    writeOp(current);
    const receiptTimestamp = Date.now();
    prepareLearnedOutcome({
      opId: current.id, sessionId: "session-restart",
      slug: "learned-0123456789abcdefabcd",
      versionId: "12345678-1234-1234-1234-123456789abc",
      candidateId: "learned-0123456789abcdefabcd",
      outcome: "partial", timestamp: receiptTimestamp,
    });
    const replay = vi.fn((_op: Op, _outcome: LearnedOutcome, _sessionId: string, _timestamp?: number) => undefined);

    expect(reconcileCanonicalLearnedOutcomes(replay).committed).toEqual([current.id]);
    expect(readReceipt(current.id).status).toBe("committed");
    reconcileCanonicalLearnedOutcomes(replay);
    expect(replay).toHaveBeenCalledTimes(2);
    expect(replay).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: current.id }), "partial", "session-restart", receiptTimestamp,
    );
    expect(replay.mock.calls.map((call) => call[3])).toEqual([receiptTimestamp, receiptTimestamp]);
  });

  it("quarantines a pending receipt when restart finds a user-cancelled op", () => {
    const current = op("restart-cancelled");
    current.canonical!.state = "cancelled";
    current.status = "cancelled";
    writeOp(current);
    prepareLearnedOutcome({
      opId: current.id, sessionId: "session-cancelled",
      slug: "learned-0123456789abcdefabcd",
      versionId: "12345678-1234-1234-1234-123456789abc",
      candidateId: "learned-0123456789abcdefabcd",
      outcome: "clean", timestamp: Date.now(),
    });
    const replay = vi.fn();

    const report = reconcileCanonicalLearnedOutcomes(replay);
    expect(report.committed).toEqual([]);
    expect(report.quarantined).toHaveLength(1);
    expect(replay).not.toHaveBeenCalled();
    expect(existsSync(receiptPath(current.id))).toBe(false);
  });
});
