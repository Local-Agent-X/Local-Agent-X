import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleProvidersRoutes } from "../src/routes/settings/providers.js";
import type { ServerContext } from "../src/server-context.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";
import type { LocalRuntimeInfo } from "../src/local-runtimes/types.js";

const OLLAMA_RT: LocalRuntimeInfo = {
  kind: "ollama",
  id: "ollama@127.0.0.1:11434",
  label: "Ollama",
  endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" },
  chatBaseUrl: "http://127.0.0.1:11434/v1",
  models: [
    { id: "qwen3.6:27b", contextWindow: 32768, tools: true },
    { id: "mxbai-embed-large:latest", contextWindow: 512, tools: false },
  ],
  refreshedAt: 1,
};
const LMSTUDIO_RT: LocalRuntimeInfo = {
  kind: "openai-compat",
  id: "openai-compat@127.0.0.1:1234",
  label: "LM Studio",
  endpoint: { baseUrl: "http://127.0.0.1:1234", origin: "auto" },
  chatBaseUrl: "http://127.0.0.1:1234/v1",
  models: [{ id: "google/gemma-4-e4b", contextWindow: null, tools: true }],
  refreshedAt: 1,
};

const savedSettings: Record<string, unknown>[] = [];
let settingsBag: Record<string, unknown> = {};
let localOnly = false;

vi.mock("../src/settings.js", () => ({
  loadSettings: () => settingsBag,
  saveSettings: (s: Record<string, unknown>) => { savedSettings.push(s); settingsBag = s; },
}));
vi.mock("../src/config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:11434" }),
}));
vi.mock("../src/local-only-policy.js", () => ({
  isLocalOnlyMode: () => localOnly,
  isLoopbackUrl: (u: string) => /127\.0\.0\.1|localhost|\[::1\]/.test(u),
  localProviderDecision: () => ({ allowed: true }),
  LOCAL_ONLY_BLOCK_MESSAGE: "blocked",
}));
vi.mock("../src/local-runtimes/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/local-runtimes/index.js")>();
  return {
    ...real,
    getLocalRuntimes: vi.fn(() => [OLLAMA_RT, LMSTUDIO_RT]),
    localRuntimesStale: () => false,
    refreshLocalRuntimes: vi.fn(async () => [OLLAMA_RT, LMSTUDIO_RT]),
    invalidateLocalRuntimes: vi.fn(),
  };
});
vi.mock("../src/auth/index.js", () => ({ loadTokens: () => null }));
vi.mock("../src/auth/anthropic.js", () => ({
  loadAnthropicTokens: () => null,
  isAnthropicCliAuthenticated: () => false,
}));
vi.mock("../src/auth/xai.js", () => ({ loadXaiTokens: () => null }));

function makeCtx(): ServerContext {
  return {
    secretsStore: { has: () => false },
    config: {},
  } as unknown as ServerContext;
}

async function call(method: string, path: string, body?: unknown) {
  const url = new URL(`http://test${path}`);
  const req = mockJsonRequest(body ?? {});
  const captured = mockResponse();
  const handled = await handleProvidersRoutes(method, url, req, captured.res, makeCtx(), "owner");
  return {
    handled,
    status: captured.status,
    json: () => JSON.parse(captured.body) as never,
  };
}

beforeEach(() => {
  settingsBag = {};
  savedSettings.length = 0;
  localOnly = false;
});

describe("GET /api/providers — local entry is the union across runtimes", () => {
  it("lists one 'local' provider carrying models from BOTH Ollama and LM Studio", async () => {
    const result = await call("GET", "/api/providers");
    const body = result.json() as { providers: Array<{ id: string; name: string; models: string[]; runtimes?: unknown[] }> };
    const local = body.providers.find(p => p.id === "local");
    expect(local).toBeDefined();
    expect(local!.name).toBe("Local Models");
    expect(local!.models).toContain("qwen3.6:27b");
    expect(local!.models).toContain("google/gemma-4-e4b");
    // embedding models are filtered from the picker union
    expect(local!.models).not.toContain("mxbai-embed-large:latest");
    expect(local!.runtimes).toHaveLength(2);
  });
});

describe("POST /api/local-runtimes — manual add", () => {
  it("persists a valid loopback entry and reports reachability", async () => {
    const result = await call("POST", "/api/local-runtimes", {
      kind: "openai-compat", baseUrl: "http://127.0.0.1:5000/", label: "vLLM box",
    });
    expect(result.status).toBe(200);
    expect(savedSettings).toHaveLength(1);
    expect(settingsBag.localRuntimes).toEqual([
      { kind: "openai-compat", baseUrl: "http://127.0.0.1:5000", label: "vLLM box" },
    ]);
  });

  it("rejects bad kind / bad URL / duplicates", async () => {
    expect((await call("POST", "/api/local-runtimes", { kind: "nope", baseUrl: "http://127.0.0.1:5000" })).status).toBe(400);
    expect((await call("POST", "/api/local-runtimes", { kind: "ollama", baseUrl: "garbage" })).status).toBe(400);
    settingsBag = { localRuntimes: [{ kind: "ollama", baseUrl: "http://127.0.0.1:5000" }] };
    expect((await call("POST", "/api/local-runtimes", { kind: "ollama", baseUrl: "http://127.0.0.1:5000" })).status).toBe(409);
  });

  it("refuses non-loopback adds in strict local-only mode", async () => {
    localOnly = true;
    const result = await call("POST", "/api/local-runtimes", {
      kind: "openai-compat", baseUrl: "http://192.168.1.50:8000",
    });
    expect(result.status).toBe(403);
    expect(savedSettings).toHaveLength(0);
  });
});

describe("DELETE /api/local-runtimes", () => {
  it("removes by host:port identity", async () => {
    settingsBag = {
      localRuntimes: [
        { kind: "ollama", baseUrl: "http://127.0.0.1:5000" },
        { kind: "openai-compat", baseUrl: "http://127.0.0.1:6000" },
      ],
    };
    const result = await call("DELETE", "/api/local-runtimes?baseUrl=http://127.0.0.1:5000");
    expect(result.status).toBe(200);
    expect(settingsBag.localRuntimes).toEqual([
      { kind: "openai-compat", baseUrl: "http://127.0.0.1:6000" },
    ]);
  });
});
