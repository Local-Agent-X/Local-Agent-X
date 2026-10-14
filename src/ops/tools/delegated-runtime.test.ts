import { afterEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../types.js";
import { clearSessionWorkRoot, sessionWorkRootOf } from "../../workspace/paths.js";

const fixture = vi.hoisted(() => ({
  register: vi.fn(),
  factory: vi.fn(() => ({ name: "exact-factory" })),
  createFactory: vi.fn(),
  installRuntime: vi.fn(),
  beltCalls: [] as Array<{ lane: string; workRoot?: string }>,
  allowed: [] as Array<{ path: string; sessionId?: string }>,
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
    addAllowedPath(path: string, sessionId?: string) { fixture.allowed.push({ path, sessionId }); }
  },
}));
vi.mock("../../security/layer/index.js", () => ({
  loadFileAccessModeAtLeast: (floor: string) => floor,
}));
vi.mock("../../tool-policy/index.js", () => ({
  loadToolPolicy: () => ({ runtimeFingerprint: () => "4".repeat(64) }),
}));
vi.mock("./delegated-toolset.js", () => ({
  delegatedToolsetForOp: (lane: string, opts: { workRoot?: string } = {}) => {
    fixture.beltCalls.push({ lane, workRoot: opts.workRoot });
    return [{
      name: `read-${lane}`,
      description: "read a file",
      parameters: { type: "object" },
      execute: async () => ({ content: "" }),
    }];
  },
}));
// Faithful-shape fake: mirrors what the real buildAgentRuntimeSurface derives
// from its inputs, so the assertions below pin what shared.ts PASSES (system
// prompt, toolset, call context, session key) — the real derivation is
// covered by the agent-runner suites.
vi.mock("../../canonical-loop/agent-runner/runtime-surface.js", () => ({
  buildAgentRuntimeSurface: (
    options: { systemPrompt: string; tools: Array<{ name: string }>; callContext?: string },
    sessionId: string,
  ) => ({
    kind: "agent-runner",
    systemPrompt: options.systemPrompt,
    tools: options.tools.map((tool) => ({ name: tool.name, fingerprint: "2".repeat(64) })),
    security: {
      workspace: "C:/tmp/lax/workspace",
      fileAccessMode: "workspace",
      inlineEvalPolicy: "refuse",
      allowedPaths: [],
      ...(sessionWorkRootOf(sessionId) ? { sessionWorkRoot: sessionWorkRootOf(sessionId) } : {}),
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
const { configureDelegatedRuntime, delegatedOwnerSessionId } = await import("./shared.js");
const { DELEGATED_WORKER_PROMPT, delegatedBuildWorkerPrompt } = await import("../../server/background-jobs/prompts.js");

afterEach(() => {
  fixture.beltCalls.length = 0;
  fixture.allowed.length = 0;
  fixture.installRuntime.mockClear();
  fixture.createFactory.mockClear();
});

describe("configureDelegatedRuntime", () => {
  it("binds the op record to the submitting session, or to the op itself when unattended", () => {
    expect(delegatedOwnerSessionId("op-unattended", "")).toBe("op-unattended");
    expect(delegatedOwnerSessionId("op-attended", "chat-session")).toBe("chat-session");
  });

  it("stamps and registers one authoritative provider/model/runtime identity under the op's own session", async () => {
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
      // The worker's tool runtime is keyed by its op id; the submitting chat
      // is carried separately so progress still routes there.
      sessionId: "op-configure-exact",
      parentSessionId: "session-exact",
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
    expect(fixture.beltCalls).toEqual([{ lane: "interactive", workRoot: undefined }]);
    expect(fixture.allowed).toEqual([]);
    expect(fixture.createFactory).toHaveBeenCalledWith(op.runtimeDescriptor, {
      apiKey: "resolved-target-key",
      authSource: "sentinel",
      customBaseURL: undefined,
      sessionId: "op-configure-exact",
      systemPrompt: DELEGATED_WORKER_PROMPT,
      requireToolOnFirstTurn: true,
    });
    expect(fixture.register).toHaveBeenCalledWith(op.id, fixture.factory);
    // First-run in-process turns get a live dispatcher + tool list at once,
    // keyed by the op's session, with the parent threaded explicitly.
    expect(fixture.installRuntime).toHaveBeenCalledTimes(1);
    const [installedOp, installedOpts] = fixture.installRuntime.mock.calls[0];
    expect(installedOp).toBe(op);
    expect(installedOpts).toMatchObject({ sessionId: "op-configure-exact", parentSessionId: "session-exact", callContext: "delegated" });
    expect(installedOpts.tools.map((t: { name: string }) => t.name)).toEqual(["read-interactive"]);
    const durableState = JSON.stringify({ descriptor: op.runtimeDescriptor, telemetry: op.contextPack.promptTelemetry });
    expect(durableState).not.toContain("resolved-target-key");
  });

  it("an unattended submission carries no parent and routes nowhere else", async () => {
    const op = {
      id: "op-unattended-exact",
      lane: "background",
      contextPack: { routing: { lane: "background" } },
    } as Op;

    await configureDelegatedRuntime(op, "");

    const descriptor = op.runtimeDescriptor as unknown as Record<string, unknown>;
    expect(descriptor.sessionId).toBe("op-unattended-exact");
    expect("parentSessionId" in descriptor).toBe(false);
    const [, installedOpts] = fixture.installRuntime.mock.calls[0];
    expect("parentSessionId" in installedOpts).toBe(false);
  });

  it("a build worker's work root is registered under the op id before the surface is built, and the build prompt is sealed", async () => {
    const workRoot = "C:/tmp/lax/workspace/apps/proj";
    const op = {
      id: "op-build-exact",
      lane: "build",
      contextPack: { routing: { lane: "build", workRoot } },
    } as Op;
    try {
      await configureDelegatedRuntime(op, "session-build");

      expect(fixture.beltCalls).toEqual([{ lane: "build", workRoot }]);
      expect(fixture.allowed).toEqual([{ path: workRoot, sessionId: "op-build-exact" }]);
      expect(sessionWorkRootOf("op-build-exact")).toBeTruthy();
      expect(sessionWorkRootOf("session-build")).toBeUndefined();
      const surface = (op.runtimeDescriptor as unknown as { surface: { systemPrompt: string; security: { sessionWorkRoot?: string } } }).surface;
      expect(surface.systemPrompt).toBe(delegatedBuildWorkerPrompt(workRoot));
      expect(surface.security.sessionWorkRoot).toBe(sessionWorkRootOf("op-build-exact"));
      expect(fixture.createFactory.mock.calls[0][1]).toMatchObject({ systemPrompt: delegatedBuildWorkerPrompt(workRoot) });
    } finally {
      clearSessionWorkRoot("op-build-exact");
    }
  });
});
