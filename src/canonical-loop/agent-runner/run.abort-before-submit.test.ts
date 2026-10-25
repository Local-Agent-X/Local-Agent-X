/**
 * A Stop that lands while the agent runner is still setting up (resolving the
 * provider, building the context pack) arrives before any op exists. The
 * runner must answer "abort" and create nothing: no op written, no cancel
 * issued against an id nobody has, nothing submitted to the loop.
 *
 * The seams around the runner are mocked; the runner itself is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../../ops/types.js";

const mocks = vi.hoisted(() => ({
  submitted: [] as Op[],
  abortDuringSetup: null as null | AbortController,
}));

vi.mock("../middlewares/host.js", () => ({
  enableDefaultMiddlewareStack: vi.fn(),
  getActiveMiddlewareStack: () => [{ name: "stub" }],
}));
vi.mock("./register-adapter.js", () => ({
  resolveAgentProviderRuntime: vi.fn(async () => {
    // The Stop lands while the provider is being resolved.
    mocks.abortDuringSetup?.abort();
    return {
      resolvedRuntime: { localModelCapabilityProfile: null },
      credential: { provider: "anthropic", credential: "oauth:test", source: "oauth" },
    };
  }),
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
vi.mock("../../ops/op-store.js", () => ({
  newOpId: (prefix: string) => `${prefix}_test`,
  writeOp: vi.fn(),
}));
vi.mock("../../ops/session-bridge.js", () => ({ trackOpForSession: vi.fn() }));
vi.mock("../../ops/heartbeat.js", () => ({ getRetryPolicy: () => ({ maxRecoveryAttempts: 0, backoffMs: [] }) }));
vi.mock("../control-api.js", () => ({
  opCancel: vi.fn(),
  subscribeOpStream: vi.fn(() => () => undefined),
  subscribeOpEvents: vi.fn((_opId: string, listener: (event: unknown) => void) => {
    queueMicrotask(() => listener({ type: "state_changed", opId: _opId, body: { from: "running", to: "succeeded" } }));
    return () => undefined;
  }),
}));
vi.mock("../index.js", () => ({
  canonicalLoopEntry: vi.fn((op: Op) => { mocks.submitted.push(op); }),
}));

import { runAgentViaCanonical } from "./run.js";
import { writeOp } from "../../ops/op-store.js";
import { opCancel } from "../control-api.js";
import { trackOpForSession } from "../../ops/session-bridge.js";

function run(signal: AbortSignal) {
  return runAgentViaCanonical("do the thing", [], {
    apiKey: "oauth:test", model: "claude-opus-4-8", provider: "anthropic",
    systemPrompt: "sys", tools: [], sessionId: "sess-abort-before-submit", signal,
    security: {} as never, toolPolicy: {} as never, threatEngine: {} as never,
    rbac: {} as never, callerRole: "operator" as never,
  } as never);
}

describe("runAgentViaCanonical — a Stop before the op exists", () => {
  beforeEach(() => {
    mocks.submitted.length = 0;
    mocks.abortDuringSetup = null;
    vi.clearAllMocks();
  });

  it("already aborted on entry: answers abort and creates nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(controller.signal);
    expect(result.stopReason).toBe("abort");
    expect(result.opId).toBeUndefined();
    expect(mocks.submitted).toHaveLength(0);
    expect(writeOp).not.toHaveBeenCalled();
    expect(trackOpForSession).not.toHaveBeenCalled();
    expect(opCancel).not.toHaveBeenCalled();
  });

  it("aborted during setup: answers abort and creates nothing", async () => {
    const controller = new AbortController();
    mocks.abortDuringSetup = controller;
    const result = await run(controller.signal);
    expect(result.stopReason).toBe("abort");
    expect(mocks.submitted).toHaveLength(0);
    expect(writeOp).not.toHaveBeenCalled();
    expect(opCancel).not.toHaveBeenCalled();
  });

  it("not aborted: the op is submitted as before", async () => {
    const result = await run(new AbortController().signal);
    expect(mocks.submitted).toHaveLength(1);
    expect(result.opId).toBe(mocks.submitted[0].id);
  });
});
