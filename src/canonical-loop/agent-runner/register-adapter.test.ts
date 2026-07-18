import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalAgentOptions } from "./types.js";

const { registerAdapterForOp, createAnthropicAdapter } = vi.hoisted(() => ({
  registerAdapterForOp: vi.fn(),
  createAnthropicAdapter: vi.fn(() => ({ name: "anthropic" })),
}));

vi.mock("../runtime.js", () => ({ registerAdapterForOp }));
vi.mock("../adapters/anthropic.js", () => ({ createAnthropicAdapter }));

import { registerProviderAdapter } from "./register-adapter.js";

describe("registerProviderAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the interactive direct-HTTP preference and token cap to Anthropic", async () => {
    const options = {
      provider: "anthropic",
      model: "claude-opus-4-8",
      systemPrompt: "voice prompt",
      maxTokens: 320,
      preferAnthropicDirectHttp: true,
    } as CanonicalAgentOptions;

    await registerProviderAdapter("op-voice", options, "voice-session");

    expect(registerAdapterForOp).toHaveBeenCalledOnce();
    const factory = registerAdapterForOp.mock.calls[0][1] as () => unknown;
    factory();
    expect(createAnthropicAdapter).toHaveBeenCalledWith({
      systemPrompt: "voice prompt",
      model: "claude-opus-4-8",
      sessionId: "voice-session",
      maxTokens: 320,
      preferDirectHttp: true,
    });
  });
});
