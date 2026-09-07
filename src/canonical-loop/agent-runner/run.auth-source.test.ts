/**
 * runAgentViaCanonical must stamp the credential source it actually resolved
 * onto the op's `contextPack.routing.authSource`.
 *
 * cost-recording.ts books the op's ledger row under that field and
 * checkpoint-stop.ts judges the spend ceiling by it; `isBillableSource(
 * undefined)` is TRUE by design. Before this stamp, every agent-runner op —
 * cron missions, dream consolidation, voice turns, skill review, autopilot —
 * was booked as real API spend on a subscription (oauth) box and could be
 * checkpoint-stopped for money it never spent.
 *
 * The seams around the runner are mocked; the runner itself is real, and the
 * op it hands to canonicalLoopEntry is what is inspected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../../ops/types.js";

const mocks = vi.hoisted(() => ({
  submitted: [] as Op[],
  credentialSource: "oauth" as string,
}));

vi.mock("../middlewares/host.js", () => ({
  enableDefaultMiddlewareStack: vi.fn(),
  getActiveMiddlewareStack: () => [{ name: "stub" }],
}));
vi.mock("./register-adapter.js", () => ({
  resolveAgentProviderRuntime: vi.fn(async () => ({
    resolvedRuntime: { localModelCapabilityProfile: null },
    credential: { provider: "anthropic", credential: "oauth:test", source: mocks.credentialSource },
  })),
  registerProviderAdapter: vi.fn(async (op: Op) => {
    op.runtimeDescriptor = {
      kind: "delegated-op", adapter: "provider-exact",
      provider: "anthropic", credentialProvider: "anthropic", authSource: mocks.credentialSource,
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
    // The op "finishes" as soon as the runner is listening.
    queueMicrotask(() => listener({ type: "state_changed", opId: _opId, body: { from: "running", to: "succeeded" } }));
    return () => undefined;
  }),
}));
vi.mock("../index.js", () => ({
  canonicalLoopEntry: vi.fn((op: Op) => { mocks.submitted.push(op); }),
}));

import { runAgentViaCanonical } from "./run.js";

describe("runAgentViaCanonical — routing.authSource", () => {
  beforeEach(() => { mocks.submitted.length = 0; });

  it.each(["oauth", "api-key", "sentinel"])("stamps the resolved credential source (%s) onto the op", async (source) => {
    mocks.credentialSource = source;
    await runAgentViaCanonical("do the thing", [], {
      apiKey: "oauth:test", model: "claude-opus-4-8", provider: "anthropic",
      systemPrompt: "sys", tools: [], sessionId: "sess-auth-source",
      security: {} as never, toolPolicy: {} as never, threatEngine: {} as never,
      rbac: {} as never, callerRole: "operator" as never,
    } as never);
    expect(mocks.submitted).toHaveLength(1);
    expect(mocks.submitted[0].contextPack.routing.authSource).toBe(source);
  });
});
