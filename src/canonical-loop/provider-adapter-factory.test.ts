import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const fixture = vi.hoisted(() => ({
  cloudModels: new Set<string>(),
  anthropicTransport: { stream: vi.fn() },
  codexTransport: { stream: vi.fn() },
  defaultAnthropicTransport: vi.fn(),
  defaultCodexTransport: vi.fn(),
  createAnthropicAdapter: vi.fn(),
  createCodexAdapter: vi.fn(),
  certified: false,
}));

vi.mock("../local-runtimes/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../local-runtimes/index.js")>();
  return {
    ...original,
    getLocalRuntimeById: (id: string) => id === "runtime-1" ? {
      id,
      chatBaseUrl: "http://127.0.0.1:1234/v1",
      models: [{ id: "shared-model", contextWindow: 8_192, tools: true }],
    } : null,
    hasPublishedCertification: () => fixture.certified,
  };
});

vi.mock("../ollama-cloud.js", () => ({
  isCloudModel: (model: string) => fixture.cloudModels.has(model),
}));

vi.mock("./adapters/openai-compat.js", () => ({
  resolveOpenAICompatTarget: async (_provider: string, options: { apiKey: string }, model: string) =>
    fixture.cloudModels.has(model)
      ? { baseURL: "https://ollama.example/v1", apiKey: "cloud-secret" }
      : { baseURL: "http://127.0.0.1:11434/v1", apiKey: options.apiKey || "ollama" },
}));
vi.mock("./adapters/anthropic-transport.js", () => ({ defaultAnthropicTransport: fixture.defaultAnthropicTransport }));
vi.mock("./adapters/codex-transport.js", () => ({ defaultCodexTransport: fixture.defaultCodexTransport }));
vi.mock("./adapters/anthropic.js", () => ({ createAnthropicAdapter: fixture.createAnthropicAdapter }));
vi.mock("./adapters/codex.js", () => ({ createCodexAdapter: fixture.createCodexAdapter }));

const {
  assertExactDelegatedRuntime,
  captureTargetCapabilitySnapshot,
  createProviderAdapterFactory,
  rewriteVerifiedLocalEndpointForContainer,
  resolveProviderRuntime,
} = await import("./provider-adapter-factory.js");

beforeEach(() => {
  delete process.env.LAX_CONTAINER_HOST_GATEWAY;
  fixture.cloudModels.clear();
  fixture.certified = false;
  vi.clearAllMocks();
  fixture.defaultAnthropicTransport.mockReturnValue(fixture.anthropicTransport);
  fixture.defaultCodexTransport.mockReturnValue(fixture.codexTransport);
  fixture.createAnthropicAdapter.mockReturnValue({ name: "anthropic" });
  fixture.createCodexAdapter.mockReturnValue({ name: "codex" });
});
afterEach(() => { delete process.env.LAX_CONTAINER_HOST_GATEWAY; });

describe("delegated provider runtime identity", () => {
  it("rewrites only a verified loopback endpoint to the explicit container gateway", () => {
    process.env.LAX_CONTAINER_HOST_GATEWAY = "172.18.0.1";
    expect(rewriteVerifiedLocalEndpointForContainer("http://127.0.0.1:11434/v1"))
      .toBe("http://172.18.0.1:11434/v1");
    expect(() => rewriteVerifiedLocalEndpointForContainer("https://remote.example/v1"))
      .toThrow("container_gateway_non_loopback");
    process.env.LAX_CONTAINER_HOST_GATEWAY = "evil.example.com";
    expect(() => rewriteVerifiedLocalEndpointForContainer("http://127.0.0.1:11434/v1"))
      .toThrow("container_gateway_invalid");
  });

  it("persists rejection over prior certification for the exact local target", () => {
    fixture.certified = true;
    const snapshot = captureTargetCapabilitySnapshot({
      provider: "local",
      model: "shared-model",
      target: {
        kind: "local-runtime",
        runtimeId: "runtime-1",
        endpointFingerprint: "1".repeat(64),
      },
    }, {
      runtimeId: "runtime-1",
      baseURL: "http://127.0.0.1:1234/v1",
      model: "shared-model",
      tier: "medium",
      maxTools: 24,
      contextWindow: 8_192,
      tools: { advertised: true, verified: true, rejectsTools: true },
    });

    expect(snapshot).toMatchObject({
      tools: "unsupported",
      toolsRejected: true,
      jsonMode: "supported",
      contextWindowTokens: 8_192,
      locality: "local",
    });
  });

  it("does not reuse a local profile from another model on the same runtime", () => {
    const snapshot = captureTargetCapabilitySnapshot({
      provider: "local",
      model: "model-b",
      target: {
        kind: "local-runtime",
        runtimeId: "runtime-1",
        endpointFingerprint: "1".repeat(64),
      },
    }, {
      runtimeId: "runtime-1",
      baseURL: "http://127.0.0.1:1234/v1",
      model: "model-a",
      tier: "medium",
      maxTools: 24,
      contextWindow: 8_192,
      tools: { advertised: true, verified: true, rejectsTools: true },
    });

    expect(snapshot).toMatchObject({
      tools: "unknown",
      toolsRejected: false,
      contextWindowTokens: null,
    });
  });

  it("keeps a true local model on the non-secret local credential source", async () => {
    const resolved = await resolveProviderRuntime("local", "qwen:14b", { apiKey: "ollama", authSource: "sentinel" });
    expect(resolved.identity).toMatchObject({
        provider: "local",
        credentialProvider: "local",
        authSource: "sentinel",
        model: "qwen:14b",
        runtime: "openai-compat",
        target: { kind: "local-config" },
    });
    expect(resolved.apiKey).toBe("ollama");
    expect(resolved.baseURL).toBe("http://127.0.0.1:11434/v1");
  });

  it("pins the Ollama Cloud credential source when Local picker resolves a cloud model", async () => {
    fixture.cloudModels.add("gemma-turbo");
    const resolved = await resolveProviderRuntime("local", "gemma-turbo", { apiKey: "ollama", authSource: "sentinel" });
    expect(resolved.identity).toMatchObject({
      provider: "local",
      credentialProvider: "ollama-cloud",
      model: "gemma-turbo",
      target: { kind: "ollama-cloud" },
    });
    expect(resolved.apiKey).toBe("cloud-secret");
  });

  it("rejects a credential source unrelated to the persisted provider", () => {
    expect(() => assertExactDelegatedRuntime({
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "openai",
      credentialProvider: "xai",
      authSource: "env",
      model: "gpt-5.5",
      runtime: "openai-compat",
      target: { kind: "provider-registry", endpointFingerprint: "0".repeat(64) },
      integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
    })).toThrow("credential provider");
  });

  it("rejects provider endpoints that could persist credentials in the URL", () => {
    expect(() => assertExactDelegatedRuntime({
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "custom",
      credentialProvider: "custom",
      authSource: "secrets-store",
      model: "custom-model",
      runtime: "openai-compat",
      target: { kind: "custom-config", endpointFingerprint: "0".repeat(64) },
      baseURL: "https://provider.example/v1?api_key=must-not-persist",
      integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
    })).toThrow("must not carry an executable URL");
  });

  it("rejects an attacker endpoint when its current canonical fingerprint differs", async () => {
    const admittedFingerprint = createHash("sha256")
      .update(new URL("https://provider.example/v1").href)
      .digest("hex");
    await expect(createProviderAdapterFactory({
      provider: "custom",
      credentialProvider: "custom",
      authSource: "secrets-store",
      model: "custom-model",
      runtime: "openai-compat",
      target: { kind: "custom-config", endpointFingerprint: admittedFingerprint },
      integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
    }, {
      apiKey: "custom-key",
      authSource: "secrets-store",
      customBaseURL: "https://attacker.example/v1",
    })).rejects.toThrow("canonical provider endpoint changed since submission");
  });

  it.each([
    ["anthropic", "anthropic", "env", fixture.defaultAnthropicTransport, fixture.createAnthropicAdapter, fixture.anthropicTransport],
    ["codex", "codex", "oauth", fixture.defaultCodexTransport, fixture.createCodexAdapter, fixture.codexTransport],
  ] as const)("pins the admitted credential and source into the %s transport", async (
    provider,
    runtime,
    authSource,
    createTransport,
    createAdapter,
    transport,
  ) => {
    const resolved = await resolveProviderRuntime(provider, "exact-model", {
      apiKey: "credential-must-stay-pinned",
      authSource,
    });
    const factory = await createProviderAdapterFactory({
      provider,
      credentialProvider: provider,
      authSource,
      model: "exact-model",
      runtime,
      target: resolved.identity.target,
      sessionId: "session-exact",
      integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
    }, {
      apiKey: "credential-must-stay-pinned",
      authSource,
      sessionId: "session-exact",
    });
    factory();
    expect(createTransport).toHaveBeenCalledWith({ credential: "credential-must-stay-pinned", source: authSource });
    expect(createAdapter).toHaveBeenCalledWith(expect.objectContaining({ transport, sessionId: "session-exact" }));
  });

  it("rejects a changed direct provider endpoint fingerprint", async () => {
    await expect(createProviderAdapterFactory({
      provider: "anthropic",
      credentialProvider: "anthropic",
      authSource: "env",
      model: "exact-model",
      runtime: "anthropic",
      target: { kind: "provider-registry", endpointFingerprint: "0".repeat(64) },
      integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
    }, {
      apiKey: "credential-must-stay-pinned",
      authSource: "env",
    })).rejects.toThrow("canonical provider endpoint changed");
  });
});
