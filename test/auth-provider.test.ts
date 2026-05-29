import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretsStore } from "../src/secrets.js";

// Mock the three credential loaders so the OAuth adapters resolve against
// controlled fakes — no real PKCE flow, no ~/.lax token files, and no heavy
// auth/index.js transitive imports (config, codex-mirror, storage).
vi.mock("../src/auth/anthropic.js", () => ({
  getAnthropicApiKey: vi.fn(),
  loadAnthropicTokens: vi.fn(),
}));
vi.mock("../src/auth/index.js", () => ({
  getApiKey: vi.fn(),
  loadTokens: vi.fn(),
}));
vi.mock("../src/auth/xai.js", () => ({
  getXaiApiKey: vi.fn(),
  loadXaiTokens: vi.fn(),
}));

import { AUTH_PROVIDERS } from "../src/auth/auth-provider.js";
import { PROVIDERS } from "../src/providers/registry.js";
import { PROVIDER_IDS } from "../src/providers/provider-ids.js";
import { getAnthropicApiKey, loadAnthropicTokens } from "../src/auth/anthropic.js";
import { getApiKey, loadTokens } from "../src/auth/index.js";
import { getXaiApiKey, loadXaiTokens } from "../src/auth/xai.js";

const store = (entries: Record<string, string>): SecretsStore =>
  ({ get: (k: string) => entries[k] }) as unknown as SecretsStore;
const EMPTY = store({});

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "CUSTOM_API_KEY",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("registry wiring — every provider routes to its adapter", () => {
  it.each(PROVIDER_IDS)("PROVIDERS[%s].auth is the AUTH_PROVIDERS adapter", (id) => {
    expect(PROVIDERS[id].auth).toBe(AUTH_PROVIDERS[id]);
  });
});

describe("local — keyless sentinel", () => {
  it("resolves a fixed ollama sentinel", async () => {
    expect(await AUTH_PROVIDERS.local.resolve({}, EMPTY)).toEqual({
      provider: "local",
      credential: "ollama",
      source: "sentinel",
    });
  });
  it("always reports a credential", () => {
    expect(AUTH_PROVIDERS.local.hasCredential({ secretsStore: EMPTY })).toBe(true);
  });
});

describe("custom — secrets store ONLY, no env fallback", () => {
  it("resolves from the secrets store", async () => {
    const r = await AUTH_PROVIDERS.custom.resolve({}, store({ CUSTOM_API_KEY: "k1" }));
    expect(r).toEqual({ provider: "custom", credential: "k1", source: "secrets-store" });
  });
  it("does NOT fall back to the environment", async () => {
    process.env.CUSTOM_API_KEY = "from-env";
    expect(await AUTH_PROVIDERS.custom.resolve({}, EMPTY)).toBeNull();
  });
  it("hasCredential checks the store only", () => {
    expect(AUTH_PROVIDERS.custom.hasCredential({ secretsStore: store({ CUSTOM_API_KEY: "k" }) })).toBe(true);
    expect(AUTH_PROVIDERS.custom.hasCredential({ secretsStore: EMPTY })).toBe(false);
  });
});

describe("gemini — env-key family, store then env", () => {
  it("prefers the secrets store over the environment", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    const r = await AUTH_PROVIDERS.gemini.resolve({}, store({ GEMINI_API_KEY: "store-key" }));
    expect(r).toEqual({ provider: "gemini", credential: "store-key", source: "secrets-store" });
  });
  it("falls back to the environment when the store is empty", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    const r = await AUTH_PROVIDERS.gemini.resolve({}, EMPTY);
    expect(r).toEqual({ provider: "gemini", credential: "env-key", source: "env" });
  });
  it("hasCredential ignores the environment (store-only probe)", () => {
    process.env.GEMINI_API_KEY = "env-key";
    expect(AUTH_PROVIDERS.gemini.hasCredential({ secretsStore: EMPTY })).toBe(false);
    expect(AUTH_PROVIDERS.gemini.hasCredential({ secretsStore: store({ GEMINI_API_KEY: "x" }) })).toBe(true);
  });
});

describe("openai — config key → store → env", () => {
  it("config key wins over everything", async () => {
    process.env.OPENAI_API_KEY = "env-key";
    const r = await AUTH_PROVIDERS.openai.resolve(
      { configOpenAIKey: "cfg" },
      store({ OPENAI_API_KEY: "store-key" }),
    );
    expect(r).toEqual({ provider: "openai", credential: "cfg", source: "config" });
  });
  it("store beats env when no config key", async () => {
    process.env.OPENAI_API_KEY = "env-key";
    const r = await AUTH_PROVIDERS.openai.resolve({}, store({ OPENAI_API_KEY: "store-key" }));
    expect(r).toEqual({ provider: "openai", credential: "store-key", source: "secrets-store" });
  });
  it("env is the last resort", async () => {
    process.env.OPENAI_API_KEY = "env-key";
    const r = await AUTH_PROVIDERS.openai.resolve({}, EMPTY);
    expect(r).toEqual({ provider: "openai", credential: "env-key", source: "env" });
  });
  it("hasCredential accepts a config key or a store entry", () => {
    expect(AUTH_PROVIDERS.openai.hasCredential({ secretsStore: EMPTY, configOpenAIKey: "cfg" })).toBe(true);
    expect(AUTH_PROVIDERS.openai.hasCredential({ secretsStore: store({ OPENAI_API_KEY: "k" }) })).toBe(true);
    expect(AUTH_PROVIDERS.openai.hasCredential({ secretsStore: EMPTY })).toBe(false);
  });
});

describe("anthropic — OAuth XOR api-key, rejectOAuth honored", () => {
  it("returns the OAuth sentinel when available", async () => {
    vi.mocked(getAnthropicApiKey).mockResolvedValue("cli");
    const r = await AUTH_PROVIDERS.anthropic.resolve({}, EMPTY);
    expect(r).toEqual({ provider: "anthropic", credential: "cli", source: "oauth" });
  });
  it("with rejectOAuth, an oauth: credential falls through to store/env", async () => {
    vi.mocked(getAnthropicApiKey).mockResolvedValue("oauth:tok");
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    const r = await AUTH_PROVIDERS.anthropic.resolve({ rejectOAuth: true }, EMPTY);
    expect(r).toEqual({ provider: "anthropic", credential: "sk-ant-env", source: "env" });
  });
  it("store beats env", async () => {
    vi.mocked(getAnthropicApiKey).mockRejectedValue(new Error("no oauth"));
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    const r = await AUTH_PROVIDERS.anthropic.resolve({}, store({ ANTHROPIC_API_KEY: "sk-ant-store" }));
    expect(r).toEqual({ provider: "anthropic", credential: "sk-ant-store", source: "secrets-store" });
  });
  it("hasCredential trusts saved anthropic tokens", () => {
    vi.mocked(loadAnthropicTokens).mockReturnValue({ accessToken: "a", provider: "anthropic" } as never);
    expect(AUTH_PROVIDERS.anthropic.hasCredential({ secretsStore: EMPTY })).toBe(true);
    vi.mocked(loadAnthropicTokens).mockReturnValue(null);
    expect(AUTH_PROVIDERS.anthropic.hasCredential({ secretsStore: EMPTY })).toBe(false);
  });
});

describe("codex — ChatGPT OAuth", () => {
  it("resolves the OAuth access token", async () => {
    vi.mocked(getApiKey).mockResolvedValue("codex-tok");
    const r = await AUTH_PROVIDERS.codex.resolve({}, EMPTY);
    expect(r).toEqual({ provider: "codex", credential: "codex-tok", source: "oauth" });
  });
  it("returns null when the loader throws", async () => {
    vi.mocked(getApiKey).mockRejectedValue(new Error("no tokens"));
    expect(await AUTH_PROVIDERS.codex.resolve({}, EMPTY)).toBeNull();
  });
  it("hasCredential reflects saved codex tokens", () => {
    vi.mocked(loadTokens).mockReturnValue({ accessToken: "a" } as never);
    expect(AUTH_PROVIDERS.codex.hasCredential({ secretsStore: EMPTY })).toBe(true);
    vi.mocked(loadTokens).mockReturnValue(null);
    expect(AUTH_PROVIDERS.codex.hasCredential({ secretsStore: EMPTY })).toBe(false);
  });
});

describe("xai — OAuth XOR env, rejectOAuth honored", () => {
  it("OAuth token wins when present", async () => {
    vi.mocked(getXaiApiKey).mockResolvedValue("xai-oauth");
    const r = await AUTH_PROVIDERS.xai.resolve({}, EMPTY);
    expect(r).toEqual({ provider: "xai", credential: "xai-oauth", source: "oauth" });
  });
  it("with rejectOAuth, falls through to store then env", async () => {
    vi.mocked(getXaiApiKey).mockResolvedValue("xai-oauth");
    process.env.XAI_API_KEY = "xai-env";
    const r = await AUTH_PROVIDERS.xai.resolve({ rejectOAuth: true }, EMPTY);
    expect(r).toEqual({ provider: "xai", credential: "xai-env", source: "env" });
  });
  it("hasCredential accepts oauth tokens or a store key", () => {
    vi.mocked(loadXaiTokens).mockReturnValue({ accessToken: "a", provider: "xai" } as never);
    expect(AUTH_PROVIDERS.xai.hasCredential({ secretsStore: EMPTY })).toBe(true);
    vi.mocked(loadXaiTokens).mockReturnValue(null);
    expect(AUTH_PROVIDERS.xai.hasCredential({ secretsStore: EMPTY })).toBe(false);
    expect(AUTH_PROVIDERS.xai.hasCredential({ secretsStore: store({ XAI_API_KEY: "k" }) })).toBe(true);
  });
});
