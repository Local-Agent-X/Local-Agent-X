/**
 * Pins resolveRegressionAuditProvider — the ONE explicit, opt-in exception to
 * "classifiers never cross-provider" (classify-with-llm.ts). Every branch
 * must degrade to null (same-model default) rather than block or fail a
 * build over an audit-provider misconfiguration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const resolvable = new Map<string, string>();
let savedSettings: Record<string, unknown> = {};

vi.mock("../settings.js", () => ({ loadSettings: () => savedSettings }));

vi.mock("../auth/resolve.js", () => ({
  resolveCredential: vi.fn(async (provider: string) => {
    const credential = resolvable.get(provider);
    return credential ? { provider, credential, source: "secrets-store" as const } : null;
  }),
}));

vi.mock("./registry.js", () => ({
  PROVIDERS: {
    anthropic: { defaultModel: "claude-sonnet-5" },
    codex: { defaultModel: "gpt-6-astra" },
    xai: { defaultModel: "grok-4.6" },
    openai: { defaultModel: "gpt-4o" },
    local: { defaultModel: "llama3:8b" },
  },
}));

const { resolveRegressionAuditProvider } = await import("./resolve-regression-audit-provider.js");

beforeEach(() => {
  resolvable.clear();
  savedSettings = {};
});

describe("resolveRegressionAuditProvider — off by default", () => {
  it("unset regressionAuditProvider → null", async () => {
    savedSettings = { provider: "xai" };
    expect(await resolveRegressionAuditProvider()).toBeNull();
  });
});

describe("resolveRegressionAuditProvider — configured and credentialed", () => {
  it("resolves the configured provider's credential and default model", async () => {
    savedSettings = { provider: "xai", regressionAuditProvider: "anthropic" };
    resolvable.set("anthropic", "key-anthropic");
    expect(await resolveRegressionAuditProvider()).toEqual({
      provider: "anthropic", apiKey: "key-anthropic", model: "claude-sonnet-5",
    });
  });

  it("an explicit regressionAuditModel overrides the provider default", async () => {
    savedSettings = { provider: "xai", regressionAuditProvider: "anthropic", regressionAuditModel: "claude-opus-5" };
    resolvable.set("anthropic", "key-anthropic");
    const ctx = await resolveRegressionAuditProvider();
    expect(ctx?.model).toBe("claude-opus-5");
  });

  it("case/whitespace in the settings value is normalized", async () => {
    savedSettings = { provider: "xai", regressionAuditProvider: " Anthropic " };
    resolvable.set("anthropic", "key-anthropic");
    expect((await resolveRegressionAuditProvider())?.provider).toBe("anthropic");
  });
});

describe("resolveRegressionAuditProvider — degrades to null, never blocks", () => {
  it("unknown provider id → null", async () => {
    savedSettings = { provider: "xai", regressionAuditProvider: "not-a-real-provider" };
    expect(await resolveRegressionAuditProvider()).toBeNull();
  });

  it("same as the active chat provider → null (no decorrelation benefit)", async () => {
    savedSettings = { provider: "anthropic", regressionAuditProvider: "anthropic" };
    resolvable.set("anthropic", "key-anthropic");
    expect(await resolveRegressionAuditProvider()).toBeNull();
  });

  it("configured provider has no usable credential → null", async () => {
    savedSettings = { provider: "xai", regressionAuditProvider: "anthropic" };
    // resolvable left empty — no credential
    expect(await resolveRegressionAuditProvider()).toBeNull();
  });

  it("resolveCredential throwing → null, not a crash", async () => {
    const { resolveCredential } = await import("../auth/resolve.js");
    vi.mocked(resolveCredential).mockRejectedValueOnce(new Error("vault locked"));
    savedSettings = { provider: "xai", regressionAuditProvider: "anthropic" };
    expect(await resolveRegressionAuditProvider()).toBeNull();
  });

  it('"local" resolves with a placeholder credential and its registry default model', async () => {
    savedSettings = { provider: "xai", regressionAuditProvider: "local" };
    expect(await resolveRegressionAuditProvider()).toEqual({
      provider: "local", apiKey: "ollama", model: "llama3:8b",
    });
  });

  it('bare "ollama" needs an explicit regressionAuditModel (not a registry entry) — null without one', async () => {
    savedSettings = { provider: "xai", regressionAuditProvider: "ollama" };
    expect(await resolveRegressionAuditProvider()).toBeNull();
  });

  it('bare "ollama" with an explicit model resolves', async () => {
    savedSettings = { provider: "xai", regressionAuditProvider: "ollama", regressionAuditModel: "llama3.2:3b" };
    expect(await resolveRegressionAuditProvider()).toEqual({
      provider: "ollama", apiKey: "ollama", model: "llama3.2:3b",
    });
  });
});
