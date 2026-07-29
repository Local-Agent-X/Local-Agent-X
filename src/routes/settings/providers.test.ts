/**
 * The composer chip and the turn must answer "is this provider available?"
 * with the SAME code. This route used to hand-roll its own credential chain
 * (secretsStore.has(...) plus direct loadTokens/loadAnthropicTokens/loadXaiTokens
 * calls) while the turn asked PROVIDERS[id].auth.hasCredential — which reads
 * secretsStore.get(). `has` answers "an entry exists", `get` answers "a usable
 * value exists"; those are different questions, so the UI could confidently
 * name a provider the turn refuses to run on.
 *
 * These tests assert the route's answer against the canonical probe's answer
 * directly, so the two cannot drift apart again by hand-maintained coincidence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import type { ProviderId } from "../../providers/provider-ids.js";
import type { SecretsStore } from "../../secrets.js";
import type { ServerContext } from "../../server-context.js";

const authMocks = vi.hoisted(() => ({
  loadTokens: vi.fn<() => unknown>(() => null),
  loadAnthropicTokens: vi.fn<() => unknown>(() => null),
  isAnthropicCliAuthenticated: vi.fn<() => boolean>(() => false),
  loadXaiTokens: vi.fn<() => unknown>(() => null),
}));

let settingsBag: Record<string, unknown> = {};
const savedSettings: Record<string, unknown>[] = [];

vi.mock("../../settings.js", () => ({
  loadSettings: () => settingsBag,
  saveSettings: (s: Record<string, unknown>) => { savedSettings.push(s); settingsBag = s; },
}));
vi.mock("../../config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:11434", maxRequestBodyBytes: 1_000_000 }),
}));
vi.mock("../../local-only-policy.js", () => ({
  isLocalOnlyMode: () => false,
  isLoopbackUrl: () => true,
  localProviderDecision: () => ({ allowed: true }),
  LOCAL_ONLY_BLOCK_MESSAGE: "blocked",
}));
vi.mock("../../local-runtimes/index.js", () => ({
  getLocalRuntimes: () => [],
  localRuntimesStale: () => false,
  refreshLocalRuntimes: async () => [],
  invalidateLocalRuntimes: () => {},
  manualRuntimeEntries: () => [],
  endpointHostPort: (u: string) => u,
  lmStudioAutoStartedAt: () => null,
  certifyLocalModel: async () => { throw new Error("unused"); },
  hasPublishedCertification: () => false,
}));
vi.mock("../../ollama-cloud.js", () => ({
  refreshCloudOllama: async () => ({ reachable: false, models: [] }),
  getCachedCloudModels: () => [],
  fetchLocalOllamaTags: async () => ({ reachable: false, models: [] }),
}));
// The auth loaders the canonical adapters wrap. Mocked at the module the
// adapters import from, so the probe and the route see identical inputs.
vi.mock("../../auth/index.js", () => ({
  loadTokens: authMocks.loadTokens,
  getApiKey: async () => "",
}));
vi.mock("../../auth/anthropic.js", () => ({
  loadAnthropicTokens: authMocks.loadAnthropicTokens,
  isAnthropicCliAuthenticated: authMocks.isAnthropicCliAuthenticated,
  getAnthropicApiKey: async () => "",
}));
vi.mock("../../auth/xai.js", () => ({
  loadXaiTokens: authMocks.loadXaiTokens,
  getXaiApiKey: async () => "",
}));
vi.mock("../../chat-ws/index.js", () => ({ broadcastAll: () => {} }));

import { handleProvidersRoutes } from "./providers.js";
import { PROVIDERS } from "../../providers/registry.js";

/** Entries the route gates on a credential. `local` is gated on runtime
 *  discovery and `ollama-cloud` is listed keyless as a connect affordance —
 *  both are documented divergences in providers.ts, so neither belongs here. */
const CREDENTIAL_GATED: ProviderId[] = ["xai", "gemini", "cerebras", "codex", "anthropic", "openai", "custom"];

/** A SecretsStore with the real `has`/`get` split: `has` is entry presence,
 *  `get` is the stored value. An entry holding "" is present but unusable. */
function makeStore(entries: Record<string, string>): SecretsStore {
  const map = new Map(Object.entries(entries));
  return {
    has: (name: string) => map.has(name),
    get: (name: string) => map.get(name),
  } as unknown as SecretsStore;
}

function makeReq(body?: unknown): Readable & { headers: Record<string, string> } {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks) as Readable & { headers: Record<string, string> };
  req.headers = {};
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  return res;
}

async function request(
  method: "GET" | "POST",
  path: string,
  store: SecretsStore,
  body?: unknown,
  openaiApiKey?: string,
) {
  const req = makeReq(body);
  const res = makeRes();
  const ctx = { secretsStore: store, config: { openaiApiKey } } as unknown as ServerContext;
  const handled = await handleProvidersRoutes(
    method,
    new URL(`http://127.0.0.1${path}`),
    req as unknown as Parameters<typeof handleProvidersRoutes>[2],
    res as unknown as Parameters<typeof handleProvidersRoutes>[3],
    ctx,
    "operator",
  );
  return { handled, status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function listedProviders(store: SecretsStore, openaiApiKey?: string): Promise<Set<string>> {
  const result = await request("GET", "/api/providers", store, undefined, openaiApiKey);
  const providers = result.body.providers as Array<{ id: string }>;
  return new Set(providers.map(p => p.id));
}

const probe = (id: ProviderId, store: SecretsStore, openaiApiKey?: string) =>
  PROVIDERS[id].auth.hasCredential({ secretsStore: store, configOpenAIKey: openaiApiKey });

beforeEach(() => {
  settingsBag = {};
  savedSettings.length = 0;
  authMocks.loadTokens.mockReset().mockReturnValue(null);
  authMocks.loadAnthropicTokens.mockReset().mockReturnValue(null);
  authMocks.isAnthropicCliAuthenticated.mockReset().mockReturnValue(false);
  authMocks.loadXaiTokens.mockReset().mockReturnValue(null);
});

describe("GET /api/providers — availability comes from the canonical probe", () => {
  it("drops a provider whose secret entry exists but holds no usable value", async () => {
    // The exact drift: the vault has a GEMINI_API_KEY entry, but its value is
    // unusable. `has` says yes, `hasCredential` (and therefore the turn) says
    // no — the chip would have named Gemini and every turn on it would fail.
    const store = makeStore({ GEMINI_API_KEY: "" });

    expect(probe("gemini", store)).toBe(false);
    expect(await listedProviders(store)).not.toContain("gemini");
  });

  it("matches the canonical probe for every credential-gated provider", async () => {
    const states: Array<Record<string, string>> = [
      {},
      { GEMINI_API_KEY: "" },
      { GEMINI_API_KEY: "gem-key", XAI_API_KEY: "" },
      { XAI_API_KEY: "xai-key", CEREBRAS_API_KEY: "", CUSTOM_API_KEY: "custom-key" },
      { OPENAI_API_KEY: "", CEREBRAS_API_KEY: "cb-key" },
    ];
    for (const entries of states) {
      const store = makeStore(entries);
      const listed = await listedProviders(store);
      for (const id of CREDENTIAL_GATED) {
        expect({ state: entries, id, listed: listed.has(id) })
          .toEqual({ state: entries, id, listed: probe(id, store) });
      }
    }
  });

  it("matches the canonical probe when the OAuth-only providers are signed in", async () => {
    authMocks.loadTokens.mockReturnValue({ accessToken: "codex" });
    authMocks.isAnthropicCliAuthenticated.mockReturnValue(true);
    authMocks.loadXaiTokens.mockReturnValue({ accessToken: "xai" });
    const store = makeStore({});

    const listed = await listedProviders(store);
    for (const id of CREDENTIAL_GATED) {
      expect({ id, listed: listed.has(id) }).toEqual({ id, listed: probe(id, store) });
    }
    expect(listed.has("codex")).toBe(true);
    expect(listed.has("anthropic")).toBe(true);
    expect(listed.has("xai")).toBe(true);
  });

  it("honors the config OpenAI key through the probe's configOpenAIKey input", async () => {
    const store = makeStore({});
    expect(await listedProviders(store, "sk-from-config")).toContain("openai");
    expect(probe("openai", store, "sk-from-config")).toBe(true);
  });
});

describe("POST /api/providers/switch — the openai→codex alias uses the same probe", () => {
  it("aliases to codex when the OPENAI_API_KEY entry exists but is unusable", async () => {
    // Same drift on the write path: `has` used to report the dead entry as a
    // real key, so the switch persisted provider=openai and every turn 401'd
    // instead of routing to the Codex OAuth the user actually has.
    authMocks.loadTokens.mockReturnValue({ accessToken: "codex" });
    const store = makeStore({ OPENAI_API_KEY: "" });

    expect(probe("openai", store)).toBe(false);
    const result = await request("POST", "/api/providers/switch", store, { provider: "openai" });

    expect(result).toMatchObject({ status: 200, body: { provider: "codex", model: "gpt-5.4" } });
    expect(savedSettings.at(-1)).toMatchObject({ provider: "codex" });
  });

  it("keeps openai when the key is real", async () => {
    authMocks.loadTokens.mockReturnValue({ accessToken: "codex" });
    const store = makeStore({ OPENAI_API_KEY: "sk-real" });

    expect(probe("openai", store)).toBe(true);
    const result = await request("POST", "/api/providers/switch", store, { provider: "openai" });

    expect(result.body).toMatchObject({ provider: "openai" });
    expect(savedSettings.at(-1)).toMatchObject({ provider: "openai" });
  });
});
