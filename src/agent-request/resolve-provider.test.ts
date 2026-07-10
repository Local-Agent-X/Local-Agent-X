/**
 * Pins the provider-switch surfacing in resolveProvider (finding PR-12).
 *
 * The bug: when the saved/requested provider's `hasCredential()` momentarily
 * fails, the resolver silently reroutes to the xai fallback AND runs its
 * default model — a Fable-5 chat continues on Grok with no signal, and a
 * modelOverride chosen for the old provider is applied verbatim to the new
 * one. The fix surfaces a `providerSwitch` event on the result and drops the
 * now-orphaned modelOverride, while leaving intentional caller overrides and
 * the happy path untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LAXConfig } from "../types.js";
import type { SecretsStore } from "../secrets.js";

// Mutable set of providers whose creds are "present" for a given test.
const credsPresent = new Set<string>();
// Mutable saved-settings map returned by loadSettings().
let savedSettings: Record<string, unknown> = {};
let localModels: Array<{ name: string }> = [];

vi.mock("../settings.js", () => ({
  loadSettings: () => savedSettings,
  getSetting: () => undefined,
}));

vi.mock("../auth/resolve.js", () => ({
  resolveCredential: async (provider: string) => ({
    credential: `key-${provider}`,
    source: "secrets-store" as const,
  }),
}));

vi.mock("../ollama-cloud.js", () => ({
  fetchLocalOllamaTags: async () => ({ reachable: true, models: localModels }),
}));

vi.mock("../providers/registry.js", () => {
  const mk = (defaultModel: string, transport: "http" | "cli") => ({
    transport,
    defaultModel,
    auth: { hasCredential: () => false }, // overridden per-id below
  });
  const PROVIDERS: Record<string, ReturnType<typeof mk>> = {
    codex: mk("gpt-5.5", "http"),
    xai: mk("grok-4.3", "http"),
    openai: mk("gpt-5.5", "http"),
    anthropic: mk("claude-opus-4-8", "cli"),
    local: mk("qwen2:7b", "http"),
    "ollama-cloud": mk("gpt-oss-120b", "http"),
    gemini: mk("gemini-2.5-pro", "http"),
    cerebras: mk("gpt-oss-120b", "http"),
    custom: mk("custom-model", "http"),
  };
  for (const [id, meta] of Object.entries(PROVIDERS)) {
    meta.auth.hasCredential = () => credsPresent.has(id);
  }
  return {
    PROVIDERS,
    isHttpProvider: (m: { transport: string }) => m.transport === "http",
  };
});

const { resolveProvider } = await import("./resolve-provider.js");

const CONFIG = {
  openaiApiKey: "",
  model: "config-fallback-model",
  temperature: 0.5,
  maxIterations: 10,
} as unknown as LAXConfig;

const SECRETS = { get: () => undefined } as unknown as SecretsStore;

describe("resolveProvider — provider-switch surfacing (PR-12)", () => {
  beforeEach(() => {
    credsPresent.clear();
    savedSettings = {};
    localModels = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it("surfaces a providerSwitch and drops the orphaned modelOverride on a forced fallback", async () => {
    // Saved provider is openai but its creds momentarily miss; only xai has creds.
    savedSettings = { provider: "openai" };
    credsPresent.add("xai");

    const res = await resolveProvider(
      CONFIG, SECRETS, "/tmp",
      undefined,
      "claude-opus-4-8", // modelOverride chosen for the OLD provider
    );

    expect(res.provider).toBe("xai");
    expect(res.providerSwitch).toEqual({
      from: "openai",
      to: "xai",
      reason: "credential-unavailable",
    });
    // The orphaned override must NOT be run verbatim on Grok — the new
    // provider's default picker runs instead.
    expect(res.model).toBe("grok-4.3");
  });

  it("does NOT emit a switch on the happy path and honors the modelOverride", async () => {
    savedSettings = { provider: "xai" };
    credsPresent.add("xai");

    const res = await resolveProvider(
      CONFIG, SECRETS, "/tmp",
      undefined,
      "grok-4.3-fast",
    );

    expect(res.provider).toBe("xai");
    expect(res.providerSwitch).toBeUndefined();
    expect(res.model).toBe("grok-4.3-fast");
  });

  it("treats an intentional caller override as a non-switch and keeps its modelOverride", async () => {
    // saved=openai, but caller explicitly overrides to anthropic (which HAS creds).
    savedSettings = { provider: "openai" };
    credsPresent.add("anthropic");
    credsPresent.add("openai");

    const res = await resolveProvider(
      CONFIG, SECRETS, "/tmp",
      "anthropic",
      "claude-sonnet-4-6",
    );

    expect(res.provider).toBe("anthropic");
    expect(res.providerSwitch).toBeUndefined();
    expect(res.model).toBe("claude-sonnet-4-6");
  });
});

describe("resolveProvider — strict local model validation", () => {
  const strictConfig = { ...CONFIG, localOnlyMode: true, ollamaUrl: "http://127.0.0.1:11434" };

  beforeEach(() => {
    savedSettings = { provider: "local", model: "qwen2:7b" };
    localModels = [{ name: "qwen2:7b" }];
  });

  it("runs only a model present on the actual loopback Ollama endpoint", async () => {
    await expect(resolveProvider(strictConfig, SECRETS, "/tmp")).resolves.toMatchObject({
      provider: "local",
      model: "qwen2:7b",
    });
  });

  it("rejects a stale cloud-only model name instead of substituting it locally", async () => {
    savedSettings.model = "cloud-only:70b";
    await expect(resolveProvider(strictConfig, SECRETS, "/tmp")).rejects.toThrow(/requires model .* to exist/i);
  });
});

describe("resolveProvider — maxIterations floor (120)", () => {
  // Regression for the "25 turns and it stops" trap: the old Settings panel
  // defaulted maxIterations to 25 (max=100), so legacy settings.json files cap
  // long agentic runs absurdly low. settings.json is read schema-less; the
  // resolver is its only chokepoint on the chat path, so the floor lives here.
  // 120 is hardcoded on purpose — if someone lowers MIN_MAX_ITERATIONS, this
  // test should scream.
  beforeEach(() => {
    credsPresent.clear();
    savedSettings = {};
    credsPresent.add("xai");
  });
  afterEach(() => vi.restoreAllMocks());

  it("clamps a legacy saved 25 up to 120", async () => {
    savedSettings = { provider: "xai", maxIterations: 25 };
    const res = await resolveProvider(CONFIG, SECRETS, "/tmp", undefined, undefined);
    expect(res.maxIterations).toBe(120);
  });

  it("clamps a low config fallback up to 120 when nothing is saved", async () => {
    savedSettings = { provider: "xai" }; // no saved maxIterations → CONFIG's 10
    const res = await resolveProvider(CONFIG, SECRETS, "/tmp", undefined, undefined);
    expect(res.maxIterations).toBe(120);
  });

  it("leaves a saved value above the floor untouched", async () => {
    savedSettings = { provider: "xai", maxIterations: 200 };
    const res = await resolveProvider(CONFIG, SECRETS, "/tmp", undefined, undefined);
    expect(res.maxIterations).toBe(200);
  });
});
