import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../../ops/types.js";
import type { CanonicalAgentOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  registerAdapterForOp: vi.fn(),
  createProviderAdapterFactory: vi.fn(async () => () => ({ name: "anthropic" })),
  resolveProviderRuntime: vi.fn(async () => ({
    identity: {
      provider: "anthropic",
      credentialProvider: "anthropic",
      authSource: "oauth",
      model: "claude-opus-4-8",
      runtime: "anthropic",
      target: { kind: "provider-registry", endpointFingerprint: "0".repeat(64) },
    },
    apiKey: "oauth:test",
  })),
}));

vi.mock("../runtime.js", () => ({ registerAdapterForOp: mocks.registerAdapterForOp }));
vi.mock("../provider-adapter-factory.js", () => ({
  createProviderAdapterFactory: mocks.createProviderAdapterFactory,
  resolveProviderRuntime: mocks.resolveProviderRuntime,
}));
vi.mock("../../auth/resolve.js", () => ({
  resolveCredential: vi.fn(async () => ({ provider: "anthropic", credential: "oauth:test", source: "oauth" })),
}));
vi.mock("../../config.js", () => ({ getRuntimeConfig: () => ({ openaiApiKey: undefined }) }));
vi.mock("../runtime-integrity.js", () => ({
  sealDelegatedRuntime: (_opId: string, descriptor: object) => ({
    ...descriptor,
    integrity: { scheme: "hmac-sha256-v1", mac: "0".repeat(64) },
  }),
}));

import { registerProviderAdapter } from "./register-adapter.js";

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
});
