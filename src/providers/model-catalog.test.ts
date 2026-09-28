import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretsStore } from "../secrets.js";

// Credentials and settings are mocked so the readers can be driven against a
// stubbed fetch: no network, no secrets store, no config file.
const mocks = vi.hoisted(() => ({
  resolveCredential: vi.fn(),
  localOnly: false,
  info: vi.fn(),
}));
vi.mock("../auth/resolve.js", () => ({ resolveCredential: mocks.resolveCredential }));
vi.mock("../config.js", () => ({ getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:11434", openaiApiKey: undefined }) }));
vi.mock("../settings.js", () => ({ getSetting: () => undefined }));
vi.mock("../local-only-policy.js", () => ({ isLocalOnlyMode: () => mocks.localOnly }));
vi.mock("../logger.js", () => ({ createLogger: () => ({ info: mocks.info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

import {
  CATALOG_PROVIDERS, cachedCatalogModels, catalogStale, hiddenShippedModels, isCatalogChatModel, mergeCatalog, pickerModelsFor,
  providerServesModel, refreshProviderCatalog, resetProviderCatalogs, warmProviderCatalogs,
} from "./model-catalog.js";
import { chatModelsFor, PROVIDERS } from "./registry.js";

type Route = (url: string, headers: Record<string, string>) => unknown;
let routes: Array<[RegExp, Route]> = [];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetProviderCatalogs();
  routes = [];
  mocks.localOnly = false;
  mocks.resolveCredential.mockReset();
  mocks.info.mockReset();
  fetchSpy = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit[1](url, init.headers)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

const key = (provider: string, credential = "k") =>
  mocks.resolveCredential.mockImplementation(async (p: string) => (p === provider ? { provider, credential, source: "secrets-store" } : null));

describe("isCatalogChatModel — the endpoints list everything, the picker wants chat ids", () => {
  it("keeps chat ids and drops modality variants, embeddings and dated snapshots", () => {
    expect(isCatalogChatModel("anthropic-api", "claude-opus-5-5")).toBe(true);
    expect(isCatalogChatModel("anthropic-api", "text-embedding-3")).toBe(false);
    expect(isCatalogChatModel("openai", "gpt-5.6-sol")).toBe(true);
    expect(isCatalogChatModel("openai", "o3-pro")).toBe(true);
    for (const id of ["gpt-4o-audio-preview", "gpt-4o-realtime-preview", "gpt-image-1", "text-embedding-3-large", "gpt-5.4-2026-03-05", "gpt-5.3-codex", "whisper-1", "tts-1"]) {
      expect(isCatalogChatModel("openai", id), id).toBe(false);
    }
    expect(isCatalogChatModel("gemini", "gemini-3.5-flash")).toBe(true);
    for (const id of ["gemini-2.5-flash-preview-tts", "gemini-3-pro-image", "gemini-embedding-001", "gemini-2.5-flash-preview-05-20", "gemini-live-2.5-flash"]) {
      expect(isCatalogChatModel("gemini", id), id).toBe(false);
    }
    expect(isCatalogChatModel("xai", "grok-4.7")).toBe(true);
    expect(isCatalogChatModel("xai", "grok-2-image-1212")).toBe(false);
    expect(isCatalogChatModel("cerebras", "llama-4-scout")).toBe(true);
    expect(isCatalogChatModel("custom", "nomic-embed-text")).toBe(false);
  });
});

describe("mergeCatalog — curated first, additions after", () => {
  it("keeps the curated order and appends sorted extras once", () => {
    expect(mergeCatalog(["b-model", "a-model"], ["z", "a-model", "c", "z"])).toEqual(["b-model", "a-model", "c", "z"]);
  });
  it("is the curated list when the catalog is empty", () => {
    expect(mergeCatalog(["x"], [])).toEqual(["x"]);
  });
  it("drops curated ids a complete catalog no longer lists, and nothing from an incomplete one", () => {
    expect(mergeCatalog(["b-model", "a-model"], ["a-model", "c"], true)).toEqual(["a-model", "c"]);
    expect(mergeCatalog(["b-model", "a-model"], ["a-model", "c"], false)).toEqual(["b-model", "a-model", "c"]);
  });
});

describe("refreshProviderCatalog", () => {
  it("reads Anthropic's /v1/models with the saved key, paginating, and lists claude ids only", async () => {
    key("anthropic-api", "sk-ant-api03-saved");
    routes.push([/api\.anthropic\.com\/v1\/models\?limit=100$/, (_u, h) => {
      expect(h["x-api-key"]).toBe("sk-ant-api03-saved");
      return { data: [{ id: "claude-opus-5-5" }, { id: "claude-mythos-5" }], has_more: true, last_id: "claude-mythos-5" };
    }]);
    routes.push([/after_id=claude-mythos-5/, () => ({ data: [{ id: "claude-haiku-4-5" }], has_more: false })]);
    const state = await refreshProviderCatalog("anthropic-api");
    expect(state.models).toEqual(["claude-opus-5-5", "claude-mythos-5", "claude-haiku-4-5"]);
    expect(state.complete).toBe(true);
    expect(catalogStale("anthropic-api")).toBe(false);
    // The picker: the shipped models the account can call, in shipped order
    // (claude-mythos-5 ships, so it sits in its shipped place, not at the end).
    expect(pickerModelsFor("anthropic-api")).toEqual(["claude-opus-5-5", "claude-mythos-5", "claude-haiku-4-5"]);
  });

  it("reads OpenAI's /v1/models as a Bearer call and keeps chat ids", async () => {
    key("openai", "sk-openai");
    routes.push([/api\.openai\.com\/v1\/models$/, (_u, h) => {
      expect(h.Authorization).toBe("Bearer sk-openai");
      return { data: [{ id: "gpt-6-sol" }, { id: "gpt-4o-audio-preview" }, { id: "text-embedding-3-large" }, { id: "gpt-5.6-sol" }] };
    }]);
    expect((await refreshProviderCatalog("openai")).models).toEqual(["gpt-6-sol", "gpt-5.6-sol"]);
    expect(pickerModelsFor("openai")).toContain("gpt-6-sol");
  });

  it("reads Gemini's models.list with the key in a header, keeping generateContent models", async () => {
    key("gemini", "AIza-saved");
    routes.push([/generativelanguage\.googleapis\.com\/v1beta\/models\?pageSize=100$/, (u, h) => {
      expect(u).not.toContain("AIza-saved");
      expect(h["x-goog-api-key"]).toBe("AIza-saved");
      return {
        models: [
          { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
        ],
        nextPageToken: "p2",
      };
    }]);
    routes.push([/pageToken=p2/, () => ({ models: [{ name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent"] }] })]);
    expect((await refreshProviderCatalog("gemini")).models).toEqual(["gemini-3.5-flash", "gemini-2.5-pro", "gemini-3.1-pro-preview"]);
  });

  it("reads xAI's language-models endpoint, falling back to /models", async () => {
    key("xai", "xai-key");
    routes.push([/api\.x\.ai\/v1\/models$/, () => ({ data: [{ id: "grok-4.7" }, { id: "grok-2-image-1212" }] })]);
    expect((await refreshProviderCatalog("xai")).models).toEqual(["grok-4.7"]);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(["https://api.x.ai/v1/language-models", "https://api.x.ai/v1/models"]);
  });

  it("caches an empty list with the error when the endpoint fails, so the picker is the shipped list", async () => {
    key("openai", "sk-openai");
    routes.push([/api\.openai\.com\/v1\/models$/, () => { throw new Error("boom"); }]);
    fetchSpy.mockImplementation(async () => new Response("nope", { status: 401 }));
    const state = await refreshProviderCatalog("openai");
    expect(state.models).toEqual([]);
    expect(state.error).toBe("HTTP 401");
    expect(state.complete).toBe(false);
    expect(pickerModelsFor("openai")).toEqual(chatModelsFor("openai"));
    expect(hiddenShippedModels("openai")).toEqual([]);
    expect(catalogStale("openai")).toBe(false); // retried after the TTL, not on every request
  });

  it("does nothing without a credential, in local-only mode, or for a provider without a catalog", async () => {
    mocks.resolveCredential.mockResolvedValue(null);
    expect((await refreshProviderCatalog("openai")).error).toBe("no credential");
    mocks.localOnly = true;
    key("openai");
    expect((await refreshProviderCatalog("openai")).error).toBe("catalog not available");
    mocks.localOnly = false;
    expect((await refreshProviderCatalog("anthropic")).error).toBe("catalog not available");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

});

describe("a complete catalog hides shipped models the provider no longer lists", () => {
  const hiddenLogs = () => mocks.info.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("hidden from the picker"));

  it("hides them from the picker, keeps them in the registry, and logs them once", async () => {
    key("openai", "sk-openai");
    routes.push([/api\.openai\.com\/v1\/models$/, () => ({ data: [{ id: "gpt-6-sol" }, { id: "gpt-4o" }] })]);
    await refreshProviderCatalog("openai");
    expect(pickerModelsFor("openai")).toEqual(["gpt-6-sol", "gpt-4o"]);
    expect(hiddenShippedModels("openai")).toEqual(chatModelsFor("openai").filter((m) => m !== "gpt-6-sol" && m !== "gpt-4o"));
    expect(PROVIDERS.openai.models).toContain("gpt-6-astra");
    expect(hiddenLogs()).toHaveLength(1);
    expect(hiddenLogs()[0]).toContain("gpt-6-astra");
    // The same lineup on the next refresh is not news.
    await refreshProviderCatalog("openai");
    expect(hiddenLogs()).toHaveLength(1);
  });

  it("hides nothing for a provider without a catalog", async () => {
    expect((await refreshProviderCatalog("anthropic")).complete).toBe(false);
    expect(pickerModelsFor("anthropic")).toEqual(chatModelsFor("anthropic"));
    expect(hiddenShippedModels("anthropic")).toEqual([]);
  });

  it("hides nothing when the page cap cut the list short", async () => {
    key("anthropic-api", "sk-ant");
    routes.push([/api\.anthropic\.com\/v1\/models/, () => ({ data: [{ id: "claude-opus-5-5" }], has_more: true, last_id: "claude-opus-5-5" })]);
    const state = await refreshProviderCatalog("anthropic-api");
    expect(state.complete).toBe(false);
    expect(pickerModelsFor("anthropic-api")).toEqual(chatModelsFor("anthropic-api"));
    expect(hiddenLogs()).toEqual([]);
  });

  it("hides nothing on a successful but empty list", async () => {
    key("xai", "xai-key");
    routes.push([/api\.x\.ai\/v1\/models$/, () => ({ data: [{ id: "grok-2-image-1212" }] })]);
    const state = await refreshProviderCatalog("xai");
    expect(state.models).toEqual([]);
    expect(state.complete).toBe(false);
    expect(pickerModelsFor("xai")).toEqual(chatModelsFor("xai"));
  });
});

describe("providerServesModel — what the request path may run", () => {
  it("always runs a shipped id, hidden or not, and a catalog extra", async () => {
    key("openai", "sk-openai");
    routes.push([/api\.openai\.com\/v1\/models$/, () => ({ data: [{ id: "gpt-6-sol" }] })]);
    await refreshProviderCatalog("openai");
    expect(hiddenShippedModels("openai")).toContain("gpt-6-astra");
    expect(providerServesModel("openai", "gpt-6-astra")).toBe(true); // a chat already on it finishes on it
    expect(providerServesModel("openai", "gpt-6-sol")).toBe(true);
    expect(providerServesModel("openai", "gpt-4-turbo")).toBe(false); // retired: the catalog is complete and lacks it
  });

  it("trusts an unlisted id while the catalog is cold or failed, and never for a provider without one", async () => {
    expect(providerServesModel("openai", "gpt-4-turbo")).toBe(true); // cold
    key("openai", "sk-openai");
    fetchSpy.mockImplementation(async () => new Response("nope", { status: 401 }));
    await refreshProviderCatalog("openai");
    expect(providerServesModel("openai", "gpt-4-turbo")).toBe(true); // failed
    expect(providerServesModel("anthropic", "claude-sonnet-4")).toBe(false); // no catalog: the shipped list is the lineup
    expect(providerServesModel("anthropic", "claude-opus-5-5")).toBe(true);
    expect(providerServesModel("custom", "anything")).toBe(true);
    expect(providerServesModel("local", "qwen3:8b")).toBe(true);
  });
});

describe("warmProviderCatalogs", () => {
  function store(entries: Record<string, string>) {
    const listeners: Array<(c: { type: "available" | "deleted"; name: string }) => void> = [];
    return {
      store: {
        get: (k: string) => entries[k],
        has: (k: string) => k in entries,
        onAvailabilityChange: (l: (c: { type: "available" | "deleted"; name: string }) => void) => { listeners.push(l); return () => {}; },
      } as unknown as SecretsStore,
      fire: (c: { type: "available" | "deleted"; name: string }) => listeners.forEach((l) => l(c)),
    };
  }

  it("refreshes only the providers whose key is saved, and again when a key is saved or removed", async () => {
    key("gemini", "AIza");
    routes.push([/generativelanguage/, () => ({ models: [{ name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] }] })]);
    const s = store({ GEMINI_API_KEY: "AIza" });
    warmProviderCatalogs(s.store);
    await vi.waitFor(() => expect(cachedCatalogModels("gemini")).toEqual(["gemini-3.5-flash"]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    s.fire({ type: "deleted", name: PROVIDERS.gemini.envKey });
    expect(cachedCatalogModels("gemini")).toEqual([]);
    expect(catalogStale("gemini")).toBe(true);

    s.fire({ type: "available", name: PROVIDERS.gemini.envKey });
    await vi.waitFor(() => expect(cachedCatalogModels("gemini")).toEqual(["gemini-3.5-flash"]));
    // A key that is not a catalog provider's is ignored.
    s.fire({ type: "available", name: "SMTP_PASS" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("every catalog provider is a key-based registry entry with a secret name", () => {
    for (const id of CATALOG_PROVIDERS) expect(PROVIDERS[id].envKey, id).not.toBe("");
  });
});
