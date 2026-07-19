import { describe, expect, it, vi } from "vitest";
import type { Op } from "../types.js";

const fixture = vi.hoisted(() => ({
  register: vi.fn(),
  factory: vi.fn(() => ({ name: "exact-factory" })),
  createFactory: vi.fn(),
}));

vi.mock("../../config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../lax-data-dir.js", () => ({ getLaxDir: () => "C:/tmp/lax" }));
vi.mock("../../secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../secrets.js")>();
  return { ...actual, getOrInitSecretsStore: () => ({}) };
});
vi.mock("../../agent-request/resolve-provider.js", () => ({
  resolveProvider: async () => ({
    provider: "local",
    model: "nondefault-local-model",
    apiKey: "ollama",
    authSource: "sentinel",
  }),
}));
vi.mock("../../canonical-loop/provider-adapter-factory.js", () => ({
  resolveProviderRuntime: async () => ({
    identity: {
      provider: "local",
      credentialProvider: "local",
      authSource: "sentinel",
      model: "nondefault-local-model",
      runtime: "openai-compat",
      target: { kind: "local-config", endpointFingerprint: "1".repeat(64) },
    },
    apiKey: "resolved-target-key",
  }),
  createProviderAdapterFactory: fixture.createFactory,
}));
vi.mock("../../canonical-loop/runtime.js", () => ({ registerAdapterForOp: fixture.register }));
vi.mock("../../canonical-loop/runtime-integrity.js", () => ({
  sealDelegatedRuntime: (_opId: string, descriptor: object) => ({
    ...descriptor,
    integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
  }),
}));

fixture.createFactory.mockResolvedValue(fixture.factory);
const { configureDelegatedRuntime, delegatedRuntimeSessionId } = await import("./shared.js");

describe("configureDelegatedRuntime", () => {
  it("uses the op id as the durable session identity for unattended submissions", () => {
    expect(delegatedRuntimeSessionId("op-unattended", "")).toBe("op-unattended");
    expect(delegatedRuntimeSessionId("op-attended", "chat-session")).toBe("chat-session");
  });

  it("stamps and registers one authoritative provider/model/runtime identity", async () => {
    const op = {
      id: "op-configure-exact",
      contextPack: { routing: { lane: "build", preferredProvider: "local" } },
    } as Op;

    await configureDelegatedRuntime(op, "session-exact");

    expect(op.model).toBe("nondefault-local-model");
    expect(op.runtimeDescriptor).toEqual({
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "local",
      credentialProvider: "local",
      authSource: "sentinel",
      model: "nondefault-local-model",
      runtime: "openai-compat",
      target: { kind: "local-config", endpointFingerprint: "1".repeat(64) },
      sessionId: "session-exact",
      integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
    });
    expect(fixture.createFactory).toHaveBeenCalledWith(op.runtimeDescriptor, {
      apiKey: "resolved-target-key",
      authSource: "sentinel",
      customBaseURL: undefined,
      sessionId: "session-exact",
    });
    expect(fixture.register).toHaveBeenCalledWith(op.id, fixture.factory);
    const durableState = JSON.stringify({ descriptor: op.runtimeDescriptor, telemetry: op.contextPack.promptTelemetry });
    expect(durableState).not.toContain("resolved-target-key");
  });
});
