import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../../ops/types.js";
import type { ResolvedProviderRuntime } from "../provider-adapter-factory.js";
import type { CanonicalAgentOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  registerAdapterForOp: vi.fn(),
  resolveCredential: vi.fn(async () => ({ provider: "anthropic", credential: "oauth:test", source: "oauth" })),
  createProviderAdapterFactory: vi.fn(async () => () => ({ name: "anthropic" })),
  resolveProviderRuntime: vi.fn(async (): Promise<ResolvedProviderRuntime> => ({
    identity: {
      provider: "anthropic",
      credentialProvider: "anthropic",
      authSource: "oauth",
      model: "claude-opus-4-8",
      runtime: "anthropic",
      target: { kind: "provider-registry", endpointFingerprint: "0".repeat(64) },
    },
    apiKey: "oauth:test",
    localModelCapabilityProfile: null,
  })),
}));

vi.mock("../runtime.js", () => ({ registerAdapterForOp: mocks.registerAdapterForOp }));
vi.mock("../provider-adapter-factory.js", () => ({
  createProviderAdapterFactory: mocks.createProviderAdapterFactory,
  resolveProviderRuntime: mocks.resolveProviderRuntime,
}));
vi.mock("../../auth/resolve.js", () => ({
  resolveCredential: mocks.resolveCredential,
}));
vi.mock("../../config.js", () => ({ getRuntimeConfig: () => ({ openaiApiKey: undefined }) }));
vi.mock("../../providers/ollama-capability-probe.js", () => ({
  probeOllamaCapabilities: vi.fn(async () => undefined),
}));
vi.mock("../runtime-integrity.js", () => ({
  sealDelegatedRuntime: (_opId: string, descriptor: object) => ({
    ...descriptor,
    integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
  }),
}));

import { registerProviderAdapter, resolveAgentProviderRuntime } from "./register-adapter.js";

describe("registerProviderAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pins the admitted credential source and interactive transport options", async () => {
    const options = {
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKey: "oauth:test",
      authSource: "oauth",
      systemPrompt: "voice prompt",
      maxTokens: 320,
      preferAnthropicDirectHttp: true,
    } as CanonicalAgentOptions;
    const op = { id: "op-voice" } as Op;

    await registerProviderAdapter(op, options, "voice-session");

    expect(mocks.createProviderAdapterFactory).toHaveBeenCalledWith(
      expect.objectContaining({ authSource: "oauth", sessionId: "voice-session" }),
      expect.objectContaining({
        apiKey: "oauth:test",
        authSource: "oauth",
        systemPrompt: "voice prompt",
        maxTokens: 320,
        preferAnthropicDirectHttp: true,
      }),
    );
    expect(mocks.registerAdapterForOp).toHaveBeenCalledWith("op-voice", expect.any(Function));
  });

  it("uses one resolved local target for prompt evidence and durable identity", async () => {
    const first: ResolvedProviderRuntime = {
      identity: {
        provider: "local",
        credentialProvider: "local",
        authSource: "sentinel",
        model: "local-model",
        runtime: "openai-compat",
        target: { kind: "local-runtime", runtimeId: "runtime-a", endpointFingerprint: "a".repeat(64) },
      },
      apiKey: "ollama",
      baseURL: "http://127.0.0.1:11434/v1",
      localModelCapabilityProfile: {
        runtimeId: "runtime-a",
        baseURL: "http://127.0.0.1:11434/v1",
        model: "local-model",
        tier: "weak",
        maxTools: 8,
        contextWindow: 8_192,
        tools: { advertised: true, verified: null, rejectsTools: false },
      },
    };
    const second: ResolvedProviderRuntime = {
      ...first,
      identity: {
        ...first.identity,
        target: { kind: "local-runtime", runtimeId: "runtime-b", endpointFingerprint: "b".repeat(64) },
      },
    };
    mocks.resolveCredential.mockResolvedValue({ provider: "local", credential: "ollama", source: "sentinel" });
    mocks.resolveProviderRuntime.mockResolvedValueOnce(first).mockResolvedValue(second);
    const options = {
      provider: "local",
      model: "local-model",
      apiKey: "ollama",
      systemPrompt: "degraded exact prompt",
    } as CanonicalAgentOptions;
    const prepared = await resolveAgentProviderRuntime(options);
    const op = { id: "op-one-resolution" } as Op;
    await registerProviderAdapter(op, options, "one-resolution", prepared);

    expect(mocks.resolveProviderRuntime).toHaveBeenCalledTimes(1);
    expect(prepared.resolvedRuntime.localModelCapabilityProfile?.runtimeId).toBe("runtime-a");
    expect(op.runtimeDescriptor).toMatchObject({
      target: { kind: "local-runtime", runtimeId: "runtime-a", endpointFingerprint: "a".repeat(64) },
    });
    expect(mocks.createProviderAdapterFactory).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ runtimeId: "runtime-a" }) }),
      expect.objectContaining({ systemPrompt: "degraded exact prompt" }),
    );
  });
});
