/**
 * OP-4 — the lost-registration fail-closed adapter and its discriminator.
 *
 * A recovered op that lost its in-memory per-op adapter must FAIL CLOSED
 * (finalize running->failed with a resubmit reason) instead of silently
 * running on the lane default with zero tools ("planning mode"). But that
 * fail-closed path must be reached ONLY on a genuine restart-recovery relaunch,
 * never on an in-process pause->resume of a lane-default rider — which also has
 * a committed op_turn on disk yet keeps its live registration.
 *
 * attemptCount identifies restart recovery; a validated durable descriptor is
 * the only exception because it proves the original runtime can be rebuilt.
 * In-process opResume never increments the count and keeps its live runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  resetCanonicalRuntime,
  registerAdapterForOp,
  setDefaultAdapterForLane,
  resolveAdapterFactory,
  lostRegistrationAdapterFactory,
  rehydrateRecoveredRuntime,
  getToolsForOp,
} from "../src/canonical-loop/runtime.js";
import { awaitIdle, enqueueOp, pumpScheduler, resetScheduler } from "../src/canonical-loop/scheduler.js";
import { insertOpTurn, readCanonicalEvents } from "../src/canonical-loop/store.js";
import { readOp, writeOp } from "../src/ops/op-store.js";
import type { Adapter } from "../src/canonical-loop/adapter-contract.js";
import type { Op } from "../src/ops/types.js";
import { sealDelegatedRuntime } from "../src/canonical-loop/runtime-integrity.js";
import { CODEX_URL } from "../src/codex-client/types.js";

let seq = 0;
let prevDataDir: string | undefined;
let tmp: string;

const codexTarget = () => ({
  kind: "provider-registry" as const,
  endpointFingerprint: createHash("sha256").update(new URL(CODEX_URL).href).digest("hex"),
});

function makeOp(over: Partial<Op>): Op {
  return {
    id: `op_op4_${seq++}`,
    type: "freeform",
    task: "t",
    lane: "build",
    attemptCount: 0,
    ...over,
  } as unknown as Op;
}

// A stand-in build-lane adapter; only its identity matters for these assertions.
function laneDefaultFactory(): Adapter {
  return {
    name: "build-lane-default",
    version: "1",
    async runTurn() {
      return {
        providerState: { adapterName: "build-lane-default", adapterVersion: "1", providerPayload: null },
        terminalReason: "done",
      };
    },
    async abort() {
      /* nothing in flight */
    },
  };
}

beforeEach(() => {
  prevDataDir = process.env.LAX_DATA_DIR;
  tmp = mkdtempSync(join(tmpdir(), "op4-"));
  process.env.LAX_DATA_DIR = tmp;
  resetCanonicalRuntime();
  resetScheduler();
});
afterEach(() => {
  resetScheduler();
  resetCanonicalRuntime();
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("OP-4 — lost-registration discriminator (attemptCount, not disk turn)", () => {
  it("in-process resume (attemptCount 0) rides the LIVE lane default even WITH a committed op_turn on disk", () => {
    const op = makeOp({ lane: "build", attemptCount: 0 });
    // The exact shape the skeptic flagged: a committed op_turn exists (the old
    // proxy would read this as "registration lost"), but the process never
    // restarted, so attemptCount is still 0 and the registration is intact.
    insertOpTurn({
      opId: op.id,
      turnIdx: 0,
      providerState: { adapterName: "build-lane-default", adapterVersion: "1", providerPayload: null },
      toolCallSummary: [],
      terminalReason: null,
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    });
    setDefaultAdapterForLane("build", laneDefaultFactory);

    const resolved = resolveAdapterFactory(op);
    expect(resolved).toBe(laneDefaultFactory);
    expect(resolved).not.toBe(lostRegistrationAdapterFactory);
  });

  it("genuine restart-recovery (attemptCount > 0, no per-op reg) fails closed to the lost-registration adapter", () => {
    const op = makeOp({ lane: "build", attemptCount: 1 });
    setDefaultAdapterForLane("build", laneDefaultFactory); // lane default present...
    // ...but a recovered op lost its per-op registration, so it must fail
    // closed rather than run tool-less on the lane default ("planning mode").
    expect(resolveAdapterFactory(op)).toBe(lostRegistrationAdapterFactory);
  });

  it("a per-op registration always wins, even for a recovered op", () => {
    const op = makeOp({ lane: "build", attemptCount: 5 });
    const perOp = laneDefaultFactory;
    registerAdapterForOp(op.id, perOp);
    expect(resolveAdapterFactory(op)).toBe(perOp);
  });

  it("a legacy lane-default descriptor fails closed after restart", () => {
    const op = makeOp({
      lane: "build",
      attemptCount: 1,
      runtimeDescriptor: { kind: "delegated-op", adapter: "lane-default", sessionId: "session-a" },
    });
    setDefaultAdapterForLane("build", laneDefaultFactory);
    expect(rehydrateRecoveredRuntime(op)).toBe(false);
    expect(resolveAdapterFactory(op)).toBe(lostRegistrationAdapterFactory);
  });

  it("rehydrates the exact persisted Codex model adapter factory", async () => {
    const op = makeOp({
      lane: "build",
      attemptCount: 1,
      model: "gpt-5.5",
      canonical: { sessionId: "session-codex" },
    });
    op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
        kind: "delegated-op",
        adapter: "provider-exact",
        provider: "codex",
        credentialProvider: "codex",
        authSource: "oauth",
        model: "gpt-5.5",
        runtime: "codex",
        target: codexTarget(),
        sessionId: "session-codex",
    });
    expect(rehydrateRecoveredRuntime(op)).toBe(true);
    const factory = resolveAdapterFactory(op);
    expect(factory).not.toBeNull();
    expect(factory).not.toBe(lostRegistrationAdapterFactory);
  });

  it("rejects a persisted model that disagrees with the operation model", () => {
    const op = makeOp({
      attemptCount: 1,
      model: "gpt-5.4-mini",
      canonical: { sessionId: "session-codex" },
    });
    op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
        kind: "delegated-op",
        adapter: "provider-exact",
        provider: "codex",
        credentialProvider: "codex",
        authSource: "oauth",
        model: "gpt-5.5",
        runtime: "codex",
        target: codexTarget(),
        sessionId: "session-codex",
    });
    expect(rehydrateRecoveredRuntime(op)).toBe(false);
    expect(resolveAdapterFactory(op)).toBe(lostRegistrationAdapterFactory);
  });

  it("rejects a checkpoint from the right adapter with the wrong adapter version", () => {
    const op = makeOp({
      attemptCount: 1,
      model: "gpt-5.5",
      canonical: { sessionId: "session-codex" },
    });
    op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "codex",
      credentialProvider: "codex",
      authSource: "oauth",
      model: "gpt-5.5",
      runtime: "codex",
      target: codexTarget(),
      sessionId: "session-codex",
    });
    insertOpTurn({
      opId: op.id,
      turnIdx: 0,
      providerState: { adapterName: "codex", adapterVersion: "9.9.9", providerPayload: null },
      toolCallSummary: [],
      terminalReason: null,
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    });
    expect(rehydrateRecoveredRuntime(op)).toBe(false);
    expect(resolveAdapterFactory(op)).toBe(lostRegistrationAdapterFactory);
  });

  it("rejects a canonical-session mismatch", () => {
    const op = makeOp({ attemptCount: 1, model: "gpt-5.5", canonical: { sessionId: "session-attacker" } });
    op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "codex",
      credentialProvider: "codex",
      authSource: "oauth",
      model: "gpt-5.5",
      runtime: "codex",
      target: codexTarget(),
      sessionId: "session-original",
    });
    expect(rehydrateRecoveredRuntime(op)).toBe(false);
    expect(resolveAdapterFactory(op)).toBe(lostRegistrationAdapterFactory);
  });

  it("rejects a tampered surface before restoring any tool registration", () => {
    const op = makeOp({ attemptCount: 1, model: "gpt-5.5", canonical: { sessionId: "session-codex" } });
    op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "codex",
      credentialProvider: "codex",
      authSource: "oauth",
      model: "gpt-5.5",
      runtime: "codex",
      target: codexTarget(),
      sessionId: "session-codex",
      surface: {
        kind: "agent-runner",
        systemPrompt: "original",
        tools: [{ name: "write", fingerprint: "1".repeat(64) }],
        security: { workspace: tmp, fileAccessMode: "workspace", configFingerprint: "2".repeat(64) },
        threatEngine: false,
        rbac: false,
        callContext: "api",
      },
    });
    op.runtimeDescriptor.surface!.systemPrompt = "attacker";
    expect(rehydrateRecoveredRuntime(op)).toBe(false);
    expect(getToolsForOp(op.id)).toEqual([]);
    expect(resolveAdapterFactory(op)).toBe(lostRegistrationAdapterFactory);
  });

  it("malformed persisted descriptors retain the fail-closed lost-registration behavior", () => {
    const op = makeOp({
      lane: "build",
      attemptCount: 1,
      runtimeDescriptor: { kind: "delegated-op", adapter: "unknown" } as never,
    });
    setDefaultAdapterForLane("build", laneDefaultFactory);
    expect(rehydrateRecoveredRuntime(op)).toBe(false);
    expect(resolveAdapterFactory(op)).toBe(lostRegistrationAdapterFactory);
  });

  it("terminates an unreconstructable runtime once and keeps the lane moving", async () => {
    const failed = makeOp({
      lane: "background",
      attemptCount: 1,
      model: "local-model",
      status: "queued",
      ownerId: "local-user",
      visibility: "private",
      createdAt: new Date().toISOString(),
      contextPack: {
        task: { description: "recover", successCriteria: [], constraints: [], notWhatToRedo: [] },
        context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
        capabilities: {},
        budget: { maxIterations: 2, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
        routing: { lane: "background" },
        secrets: { allowed: [] },
      },
      retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [] },
      canonical: { flagValue: true, state: "queued", sessionId: "session-failed" },
    });
    failed.runtimeDescriptor = sealDelegatedRuntime(failed.id, {
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "local",
      credentialProvider: "local",
      authSource: "sentinel",
      model: "local-model",
      runtime: "openai-compat",
      target: { kind: "local-config", endpointFingerprint: "0".repeat(64) },
      sessionId: "session-failed",
    });
    const next = makeOp({
      lane: "background",
      model: "test-model",
      status: "queued",
      ownerId: "local-user",
      visibility: "private",
      createdAt: new Date().toISOString(),
      contextPack: failed.contextPack,
      retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [] },
      canonical: { flagValue: true, state: "queued", sessionId: "session-next" },
    });
    writeOp(failed);
    writeOp(next);
    expect(rehydrateRecoveredRuntime(failed)).toBe(true);
    registerAdapterForOp(next.id, laneDefaultFactory);
    enqueueOp(failed.id, "background");
    enqueueOp(next.id, "background");
    pumpScheduler();
    await awaitIdle();

    expect(readOp(failed.id)?.canonical?.state).toBe("failed");
    expect(readOp(failed.id)?.attemptCount).toBe(1);
    expect(readOp(failed.id)?.lastFailureReason).toBe("runtime_reconstruction:identity_endpoint_fingerprint_changed");
    expect(readCanonicalEvents(failed.id).filter(event => event.type === "error")).toHaveLength(1);
    expect(readOp(next.id)?.canonical?.state).toBe("succeeded");
  });
});
