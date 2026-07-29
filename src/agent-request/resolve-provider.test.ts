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

// Mutable set of providers the SYNC `hasCredential()` probe reports present —
// the cheap auto-detect signal that drives the fallback chain.
const credsPresent = new Set<string>();
// Providers the ASYNC `resolveCredential()` can actually produce a key for, and
// that the sync probe CANNOT see. The two are modelled separately because they
// really do disagree in production and it is deliberate: src/auth/auth-provider.ts
// states it verbatim — "`resolve()` falls back to process.env; `hasCredential()`
// never does" — so a provider configured by env var alone reads UNAVAILABLE to
// the probe and AVAILABLE to the resolve that runs the turn. A mock that let
// them agree could not express the bug that asymmetry causes.
const credsResolvable = new Set<string>();
// Mutable saved-settings map returned by loadSettings().
let savedSettings: Record<string, unknown> = {};
let localModels: Array<{ name: string }> = [];

vi.mock("../settings.js", () => ({
  loadSettings: () => savedSettings,
  getSetting: () => undefined,
}));

vi.mock("../auth/resolve.js", () => ({
  resolveCredential: async (provider: string) =>
    (credsPresent.has(provider) || credsResolvable.has(provider)
      ? { credential: `key-${provider}`, source: "secrets-store" as const }
      : null),
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

// Pipeline steps prepareAgentRequest runs that the delivery test below has no
// use for (tool selection, memory/context, the curate nudge, the system-prompt
// build). Stubbed so the provider-switch journey can be exercised through the
// real prepare pipeline without standing up a memory manager.
vi.mock("./prepare-request/build-context.js", () => ({
  buildContext: async () => ({
    contextBlock: "", relevantMemories: [], smartContext: "", memoryContext: "",
    protocolNotice: "", notifications: [], knownProjectsFound: false,
  }),
  isTrivialToolRequest: () => false,
}));

vi.mock("./prepare-request/tool-selection.js", () => ({
  selectTools: async () => ({
    tools: [], tier: "strong", intentVerdict: null,
    forceBuildIntent: false, productBuildTurn: null, isBridge: false,
  }),
}));

vi.mock("./prepare-request/curate-nudge.js", () => ({
  detectAndBoostCurate: async () => "",
}));

vi.mock("./prepare-request/build-system-prompt.js", () => ({
  buildSystemPromptWithTelemetry: async () => ({ prompt: "SYSTEM", renderedSections: [] }),
}));

const { resolveProvider } = await import("./resolve-provider.js");
const { prepareAgentRequest } = await import("./prepare-request.js");

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
    credsResolvable.clear();
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

  /**
   * The asymmetry the switch used to mistake for a dead credential (C2.1
   * skeptic finding 1). `hasCredential()` is a cheap SYNC probe that never
   * reads process.env (and anthropic's never reads the secrets store at all),
   * while the `resolve()` that actually runs the turn reads both. So an
   * env-configured install — the headless/CI shape — looks unavailable to the
   * chain and perfectly fine to the request. Rerouting there abandons a
   * provider that WORKS, and any caller that acts on the resulting switch (the
   * interactive chat path fails the turn on it) punishes a healthy config.
   */
  it("keeps the requested provider when only the async resolver can see its credential", async () => {
    savedSettings = { provider: "gemini" };  // what the user picked
    credsPresent.add("xai");                 // the fallback chain's first choice
    credsResolvable.add("gemini");           // GEMINI_API_KEY in env only

    const res = await resolveProvider(CONFIG, SECRETS, "/tmp");

    expect(res.provider).toBe("gemini");
    expect(res.providerSwitch).toBeUndefined();
    // ...and the turn runs on the credential the resolver actually found.
    expect(res.apiKey).toBe("key-gemini");
    expect(res.model).toBe("gemini-2.5-pro");
  });

  it("still reports the switch when the requested provider resolves to nothing", async () => {
    // Same shape, credential genuinely absent from BOTH sources: this one is a
    // real downgrade and must stay visible to the caller.
    savedSettings = { provider: "gemini" };
    credsPresent.add("xai");

    const res = await resolveProvider(CONFIG, SECRETS, "/tmp");

    expect(res.provider).toBe("xai");
    expect(res.providerSwitch).toEqual({
      from: "gemini",
      to: "xai",
      reason: "credential-unavailable",
    });
  });
});

/**
 * C2.1 — the delivery half of the same object. The tests above prove the
 * switch is RETURNED by the resolver; they passed the whole time the live bug
 * was running turns on the wrong model, because `providerSwitch` was not a
 * field on PreparedAgentRequest — so the chat path structurally could not see
 * it (a dead xAI credential ran on Anthropic while the composer still showed
 * grok-4.5). This pins the pass-through: whatever the resolver decided about
 * the requested provider reaches the caller that has to act on it.
 */
describe("prepareAgentRequest — providerSwitch delivery (C2.1)", () => {
  const INPUT = {
    channel: "web" as const,
    message: "hello",
    sessionMessages: [],
    sessionId: "sess-c21-delivery",
    config: CONFIG,
    dataDir: "/tmp",
    memoryIndex: {} as never,
    memoryManager: {} as never,
    integrations: {} as never,
    secretsStore: SECRETS,
    allAgentTools: [],
    bridgeTools: [],
  };

  beforeEach(() => {
    credsPresent.clear();
    credsResolvable.clear();
    savedSettings = {};
  });
  afterEach(() => vi.restoreAllMocks());

  it("hands the caller the switch when the selected provider's credential is dead", async () => {
    savedSettings = { provider: "xai" }; // what the composer is showing
    credsPresent.add("anthropic");       // ...the only credential that works

    const prepared = await prepareAgentRequest(INPUT);

    expect(prepared.provider).toBe("anthropic");
    expect(prepared.providerSwitch).toEqual({
      from: "xai",
      to: "anthropic",
      reason: "credential-unavailable",
    });
  });

  // NEGATIVE CONTROL — no teeth on its own, and that is the point. It asserts
  // the pre-change value (`undefined` was what every caller saw before the
  // field existed), so it passes against both builds; deleting the pass-through
  // in prepare-request.ts would leave it green. It is meaningful only PAIRED
  // with the positive sibling above, which does fail without the field: the two
  // together say "the switch arrives exactly when there is one, and never
  // otherwise". Do not read a pass here as evidence of the delivery working.
  it("leaves it undefined when the turn runs on the provider that was asked for", async () => {
    savedSettings = { provider: "xai" };
    credsPresent.add("xai");

    const prepared = await prepareAgentRequest(INPUT);

    expect(prepared.provider).toBe("xai");
    expect(prepared.providerSwitch).toBeUndefined();
  });

  /**
   * Finding 1's exact repro carried to the seam the chat path reads. Settings
   * name a provider whose key lives only in the process env: the sync probe
   * misses it, the async resolve finds it. The prepared request must describe a
   * turn on the provider the user picked with NO switch attached — a switch
   * here is what fails an otherwise-healthy turn downstream.
   */
  it("delivers no switch for an env-only credential the sync probe cannot see", async () => {
    savedSettings = { provider: "gemini" };
    credsPresent.add("xai");
    credsResolvable.add("gemini");

    const prepared = await prepareAgentRequest(INPUT);

    expect(prepared.provider).toBe("gemini");
    expect(prepared.apiKey).toBe("key-gemini");
    expect(prepared.providerSwitch).toBeUndefined();
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

describe("resolveProvider — reasoningEffort from settings", () => {
  beforeEach(() => {
    credsPresent.clear();
    credsResolvable.clear();
    savedSettings = {};
    credsPresent.add("xai");
  });
  afterEach(() => vi.restoreAllMocks());

  it("defaults to medium when nothing is saved", async () => {
    savedSettings = { provider: "xai" };
    const res = await resolveProvider(CONFIG, SECRETS, "/tmp");
    expect(res.reasoningEffort).toBe("medium");
  });

  it("honors a saved level", async () => {
    savedSettings = { provider: "xai", reasoningEffort: "xhigh" };
    const res = await resolveProvider(CONFIG, SECRETS, "/tmp");
    expect(res.reasoningEffort).toBe("xhigh");
  });

  it("normalizes garbage in schema-less settings.json back to medium", async () => {
    savedSettings = { provider: "xai", reasoningEffort: "turbo-brain" };
    const res = await resolveProvider(CONFIG, SECRETS, "/tmp");
    expect(res.reasoningEffort).toBe("medium");
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
    credsResolvable.clear();
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
