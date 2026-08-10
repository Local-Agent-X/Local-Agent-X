import { describe, expect, it, vi } from "vitest";
import type { Op } from "../types.js";

const fixture = vi.hoisted(() => ({
  register: vi.fn(),
  factory: vi.fn(() => ({ name: "exact-factory" })),
  createFactory: vi.fn(),
  installRuntime: vi.fn(),
}));

vi.mock("../../config.js", () => ({ getRuntimeConfig: () => ({ workspace: "C:/tmp/lax/workspace" }) }));
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
vi.mock("../../security/index.js", () => ({
  SecurityLayer: class {
    constructor(public workspace: string, public fileAccessMode: string) {}
  },
}));
vi.mock("../../security/layer/index.js", () => ({
  loadFileAccessModeAtLeast: (floor: string) => floor,
}));
vi.mock("../../tool-policy/index.js", () => ({
  loadToolPolicy: () => ({ runtimeFingerprint: () => "4".repeat(64) }),
}));
vi.mock("./delegated-toolset.js", () => ({
  delegatedToolsetForOp: (lane: string) => [{
    name: `read-${lane}`,
    description: "read a file",
    parameters: { type: "object" },
    execute: async () => ({ content: "" }),
  }],
}));
// Faithful-shape fake: mirrors what the real buildAgentRuntimeSurface derives
// from its inputs, so the assertions below pin what shared.ts PASSES (system
// prompt, toolset, call context) — the real derivation is covered by the
// agent-runner suites.
vi.mock("../../canonical-loop/agent-runner/runtime-surface.js", () => ({
  buildAgentRuntimeSurface: (
    options: { systemPrompt: string; tools: Array<{ name: string }>; callContext?: string },
    _sessionId: string,
  ) => ({
    kind: "agent-runner",
    systemPrompt: options.systemPrompt,
    tools: options.tools.map((tool) => ({ name: tool.name, fingerprint: "2".repeat(64) })),
    security: {
      workspace: "C:/tmp/lax/workspace",
      fileAccessMode: "workspace",
      inlineEvalPolicy: "refuse",
      allowedPaths: [],
      configFingerprint: "3".repeat(64),
    },
    toolPolicyFingerprint: "4".repeat(64),
    threatEngine: false,
    rbac: false,
    callContext: options.callContext ?? "api",
  }),
  installOpToolRuntime: fixture.installRuntime,
}));

fixture.createFactory.mockResolvedValue(fixture.factory);
const { configureDelegatedRuntime, delegatedRuntimeSessionId } = await import("./shared.js");
const { DELEGATED_WORKER_PROMPT } = await import("../../server/background-jobs/prompts.js");

describe("configureDelegatedRuntime", () => {
  it("uses the op id as the durable session identity for unattended submissions", () => {
    expect(delegatedRuntimeSessionId("op-unattended", "")).toBe("op-unattended");
    expect(delegatedRuntimeSessionId("op-attended", "chat-session")).toBe("chat-session");
  });

  it("stamps and registers one authoritative provider/model/runtime identity", async () => {
    const op = {
      id: "op-configure-exact",
      lane: "interactive",
      contextPack: { routing: { lane: "interactive", preferredProvider: "local" } },
    } as Op;

    await configureDelegatedRuntime(op, "session-exact");

    expect(op.model).toBe("nondefault-local-model");
    const { surface, ...identity } = op.runtimeDescriptor as unknown as Record<string, unknown> & { surface: unknown };
    expect(identity).toEqual({
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
    // The descriptor now carries a durable surface — sealed IN the MAC — so
    // recovery can rebuild the worker's tools, dispatcher, and system prompt.
    expect(surface).toMatchObject({
      kind: "agent-runner",
      systemPrompt: DELEGATED_WORKER_PROMPT,
      callContext: "delegated",
    });
    const tools = (surface as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0].name).toBe("read-interactive");
    expect(fixture.createFactory).toHaveBeenCalledWith(op.runtimeDescriptor, {
      apiKey: "resolved-target-key",
      authSource: "sentinel",
      customBaseURL: undefined,
      sessionId: "session-exact",
      systemPrompt: DELEGATED_WORKER_PROMPT,
      requireToolOnFirstTurn: true,
    });
    expect(fixture.register).toHaveBeenCalledWith(op.id, fixture.factory);
    // First-run in-process turns get a live dispatcher + tool list at once.
    expect(fixture.installRuntime).toHaveBeenCalledTimes(1);
    const [installedOp, installedOpts] = fixture.installRuntime.mock.calls[0];
    expect(installedOp).toBe(op);
    expect(installedOpts).toMatchObject({ sessionId: "session-exact", callContext: "delegated" });
    expect(installedOpts.tools.map((t: { name: string }) => t.name)).toEqual(["read-interactive"]);
    const durableState = JSON.stringify({ descriptor: op.runtimeDescriptor, telemetry: op.contextPack.promptTelemetry });
    expect(durableState).not.toContain("resolved-target-key");
  });
});
