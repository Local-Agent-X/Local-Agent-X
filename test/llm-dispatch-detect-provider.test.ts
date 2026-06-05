import { afterEach, describe, expect, it, vi } from "vitest";

// The whole bug: dispatch's provider detection couldn't see secrets-store /
// OAuth credentials, so store users (xAI, Codex) fell through to a dead-ollama
// 404. detectProvider now defers to the canonical store-aware resolver.
const resolveProviderContext = vi.fn();
vi.mock("../src/providers/resolve-provider-context.js", () => ({
  resolveProviderContext: (...a: unknown[]) => resolveProviderContext(...a),
}));

const { detectProvider } = await import("../src/llm-dispatch.js");

const ctx = (provider: string) => ({ provider, apiKey: "k", model: "" });
const noEnv = () => { delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.XAI_API_KEY; };

afterEach(() => { vi.clearAllMocks(); noEnv(); });

describe("detectProvider — store-aware", () => {
  it("routes a configured xAI user to xai (was the ollama-404 case)", async () => {
    noEnv();
    resolveProviderContext.mockResolvedValue(ctx("xai"));
    expect(await detectProvider()).toBe("xai");
  });

  it("routes a configured Codex (OAuth) user to codex", async () => {
    noEnv();
    resolveProviderContext.mockResolvedValue(ctx("codex"));
    expect(await detectProvider()).toBe("codex");
  });

  it("maps the local provider alias to ollama", async () => {
    noEnv();
    resolveProviderContext.mockResolvedValue(ctx("local"));
    expect(await detectProvider()).toBe("ollama");
  });

  it("returns null — not ollama — when nothing usable is configured", async () => {
    noEnv();
    resolveProviderContext.mockResolvedValue(null);
    expect(await detectProvider()).toBeNull();
  });

  it("a non-dispatchable provider (gemini) with no env key degrades to null", async () => {
    noEnv();
    resolveProviderContext.mockResolvedValue(ctx("gemini"));
    expect(await detectProvider()).toBeNull();
  });

  it("falls back to a raw env key when no provider is configured", async () => {
    noEnv();
    resolveProviderContext.mockResolvedValue(null);
    process.env.XAI_API_KEY = "x";
    expect(await detectProvider()).toBe("xai");
  });
});
