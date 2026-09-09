/**
 * runAgentViaCanonical must translate `options.harnessAuthoredTask` into the
 * op's `taskProvenance` — and must NOT stamp it on user-authored work.
 *
 * This one expression (run.ts, in the createAgentOperation call) is the sole
 * bridge between every caller that declares its task harness-authored
 * (auto-build chunk-runner, skill-review, dream-check, agent_spawn via
 * agents/invoke) and the middleware that reads it: instruction-ledger skips
 * constraint extraction when `op.taskProvenance === "harness"`, so a dropped
 * stamp silently mines the harness's own mandate prose for "user constraints"
 * and a spuriously-added stamp discards the real user's constraints.
 *
 * Every pre-existing test asserted the OPTION was handed to a mock one layer
 * above this translation; nothing pinned the translation itself. Hard-wiring
 * the expression to `undefined` — reintroducing the bug repo-wide — left all
 * of them green. These assertions run the REAL runner and inspect the REAL
 * constructed Op, in both directions.
 *
 * Seam: `../index.js` is fully factory-mocked (run.ts imports only
 * `canonicalLoopEntry` from it), so no live agent turn is driven and the
 * circular index → run → index import is never realized. The op handed to
 * `canonicalLoopEntry` is the real one the runner built.
 *
 * op-store is deliberately NOT mocked: `writeOp` is `JSON.stringify(op)` with
 * no field whitelist, and the persisted copy is what a resumed/recovered op
 * reads back, so the round-trip is part of the contract. test/setup/test-env.ts
 * points HOME at a throwaway dir, so this writes to a per-file temp ~/.lax.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readOp } from "../../ops/op-store.js";
import { opDir } from "../../ops/event-log.js";
import type { Op } from "../../ops/types.js";

const mocks = vi.hoisted(() => ({ submitted: [] as Op[] }));

vi.mock("../middlewares/host.js", () => ({
  enableDefaultMiddlewareStack: vi.fn(),
  getActiveMiddlewareStack: () => [{ name: "stub" }],
}));
vi.mock("./register-adapter.js", () => ({
  resolveAgentProviderRuntime: vi.fn(async () => ({
    resolvedRuntime: { localModelCapabilityProfile: null },
    credential: { provider: "anthropic", credential: "oauth:test", source: "oauth" },
  })),
  registerProviderAdapter: vi.fn(async (op: Op) => {
    op.runtimeDescriptor = {
      kind: "delegated-op", adapter: "provider-exact",
      provider: "anthropic", credentialProvider: "anthropic", authSource: "oauth",
      model: "claude-opus-4-8", runtime: "anthropic",
      target: { kind: "provider-registry", endpointFingerprint: "0".repeat(64) },
      sessionId: "s", integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
    } as unknown as Op["runtimeDescriptor"];
  }),
}));
vi.mock("./prompt.js", () => ({ prepareCanonicalAgentPrompt: vi.fn(async () => undefined) }));
vi.mock("./runtime-surface.js", () => ({
  buildAgentRuntimeSurface: vi.fn(() => ({ kind: "agent-runner" })),
  installOpToolRuntime: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("./seed-messages.js", () => ({ seedOpMessages: vi.fn() }));
vi.mock("./collect-result.js", () => ({
  collectMessages: vi.fn(() => []),
  mapStopReason: vi.fn(() => "end_turn"),
}));
vi.mock("../runtime-integrity.js", () => ({
  sealDelegatedRuntime: (_opId: string, descriptor: object) => ({
    ...descriptor, integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
  }),
}));
vi.mock("../runtime.js", () => ({
  unregisterToolDispatcherForOp: vi.fn(),
  unregisterToolsForOp: vi.fn(),
}));
vi.mock("../store.js", () => ({ readOpTurns: vi.fn(() => []) }));
vi.mock("../../committing-tool-check.js", () => ({ opCommittedWork: vi.fn(() => false) }));
vi.mock("../../ops/session-bridge.js", () => ({ trackOpForSession: vi.fn() }));
vi.mock("../control-api.js", () => ({
  opCancel: vi.fn(),
  subscribeOpStream: vi.fn(() => () => undefined),
  subscribeOpEvents: vi.fn((opId: string, listener: (event: unknown) => void) => {
    // The op "finishes" as soon as the runner is listening.
    queueMicrotask(() => listener({ type: "state_changed", opId, body: { from: "running", to: "succeeded" } }));
    return () => undefined;
  }),
}));
vi.mock("../index.js", () => ({
  canonicalLoopEntry: vi.fn((op: Op) => { mocks.submitted.push(op); }),
}));

import { runAgentViaCanonical } from "./run.js";

/** Drive the real runner and hand back the real Op it built. */
async function runAndCaptureOp(extra: Record<string, unknown>): Promise<Op> {
  await runAgentViaCanonical("summarize yesterday's notes", [], {
    apiKey: "oauth:test", model: "claude-opus-4-8", provider: "anthropic",
    systemPrompt: "sys", tools: [], sessionId: "sess-task-provenance",
    opType: "agent_spawn",
    security: {} as never, toolPolicy: {} as never, threatEngine: {} as never,
    rbac: {} as never, callerRole: "operator" as never,
    ...extra,
  } as never);
  expect(mocks.submitted).toHaveLength(1);
  return mocks.submitted[0];
}

/** The persisted operation.json exactly as writeOp left it on disk. */
function persistedRaw(opId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(opDir(opId), "operation.json"), "utf-8"));
}

describe("runAgentViaCanonical — op.taskProvenance", () => {
  beforeEach(() => { mocks.submitted.length = 0; });

  it("stamps taskProvenance='harness' on the op when harnessAuthoredTask is true", async () => {
    const op = await runAndCaptureOp({ harnessAuthoredTask: true });
    expect(op.taskProvenance).toBe("harness");
  });

  it("leaves taskProvenance absent when harnessAuthoredTask is omitted (user-authored)", async () => {
    const op = await runAndCaptureOp({});
    expect(op.taskProvenance).toBeUndefined();
    expect(op.taskProvenance).not.toBe("harness");
  });

  it("leaves taskProvenance absent when harnessAuthoredTask is explicitly false", async () => {
    const op = await runAndCaptureOp({ harnessAuthoredTask: false });
    expect(op.taskProvenance).toBeUndefined();
    expect(op.taskProvenance).not.toBe("harness");
  });

  it("survives the op-store round-trip for a harness-authored op", async () => {
    const op = await runAndCaptureOp({ harnessAuthoredTask: true });
    expect(persistedRaw(op.id).taskProvenance).toBe("harness");
    expect(readOp(op.id)?.taskProvenance).toBe("harness");
  });

  it("does not manufacture a provenance on disk for a user-authored op", async () => {
    const op = await runAndCaptureOp({});
    // JSON.stringify drops an undefined value: absent key, not null.
    expect("taskProvenance" in persistedRaw(op.id)).toBe(false);
    expect(readOp(op.id)?.taskProvenance).toBeUndefined();
  });
});
