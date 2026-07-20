import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { handleProvidersRoutes } from "../src/routes/settings/providers.js";
import type { ServerContext } from "../src/server-context.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";
import type { LocalRuntimeInfo } from "../src/local-runtimes/types.js";
import type { LocalModelCertification } from "../src/local-runtimes/certification-types.js";
import { CERTIFICATION_SCENARIOS } from "../src/local-runtimes/certification-types.js";
import {
  certifyLocalModel,
  getLocalRuntimes,
  hasPublishedCertification,
  invalidateLocalRuntimes,
  refreshLocalRuntimes,
} from "../src/local-runtimes/index.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

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
let publishedRuntime: LocalRuntimeInfo | null = null;
let publishedModel = "";
const broadcastAll = vi.fn();

function certificationResult(
  runtime: LocalRuntimeInfo,
  model: string,
  reusable = true,
): LocalModelCertification {
  const scenarios = Object.fromEntries(CERTIFICATION_SCENARIOS.map((id) => [id, {
    passed: true, calls: 1, latencyMs: 2, failure: null,
  }])) as LocalModelCertification["scenarios"];
  return {
    version: 1,
    fingerprint: { hash: `${runtime.id}:${model}:private`, reusable },
    scenarios,
    passedCount: CERTIFICATION_SCENARIOS.length,
    callCount: CERTIFICATION_SCENARIOS.length,
    totalLatencyMs: CERTIFICATION_SCENARIOS.length * 2,
  };
}

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
    certifyLocalModel: vi.fn(),
    hasPublishedCertification: vi.fn(),
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
    broadcastAll,
  } as unknown as ServerContext;
}

async function call(method: string, path: string, body?: unknown, role: "operator" | "user" | "readonly" | "agent" = "operator") {
  const url = new URL(`http://test${path}`);
  const req = mockJsonRequest(body ?? {});
  const captured = mockResponse();
  const handled = await handleProvidersRoutes(method, url, req, captured.res, makeCtx(), role);
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
  publishedRuntime = null;
  publishedModel = "";
  broadcastAll.mockReset();
  vi.mocked(spawn).mockReset();
  vi.mocked(getLocalRuntimes).mockReturnValue([OLLAMA_RT, LMSTUDIO_RT]);
  vi.mocked(refreshLocalRuntimes).mockClear();
  vi.mocked(invalidateLocalRuntimes).mockClear();
  vi.mocked(certifyLocalModel).mockReset().mockImplementation(async ({ runtime, model }) => {
    publishedRuntime = runtime;
    publishedModel = model;
    return certificationResult(runtime, model);
  });
  vi.mocked(hasPublishedCertification).mockReset().mockImplementation((runtime, model) => (
    runtime === publishedRuntime && model.id === publishedModel
  ));
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
  it("denies non-operators before persistence, refresh, or broadcast", async () => {
    const result = await call("POST", "/api/local-runtimes", {
      kind: "openai-compat", baseUrl: "http://127.0.0.1:5000",
    }, "agent");
    expect(result.status).toBe(403);
    expect(result.json()).toEqual({ error: "Operator access required" });
    expect(savedSettings).toHaveLength(0);
    expect(vi.mocked(invalidateLocalRuntimes)).not.toHaveBeenCalled();
    expect(vi.mocked(refreshLocalRuntimes)).not.toHaveBeenCalled();
    expect(broadcastAll).not.toHaveBeenCalled();
  });

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

describe("POST /api/local-runtimes/certify", () => {
  it("allows the operator and selects a duplicate model id by exact runtimeId", async () => {
    const runtimeA = { ...OLLAMA_RT, models: [{ id: "shared-model", contextWindow: 8192, tools: true }] };
    const runtimeB = { ...LMSTUDIO_RT, models: [{ id: "shared-model", contextWindow: 4096, tools: false }] };
    vi.mocked(getLocalRuntimes).mockReturnValue([runtimeA, runtimeB]);

    const result = await call("POST", "/api/local-runtimes/certify", {
      runtimeId: runtimeB.id,
      model: "shared-model",
      endpoint: runtimeA.endpoint.baseUrl,
    });
    const body = result.json() as { ok: boolean; status: string; scenarios: unknown[] };

    expect(result.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("verified");
    expect(body.scenarios).toHaveLength(CERTIFICATION_SCENARIOS.length);
    expect(vi.mocked(certifyLocalModel)).toHaveBeenCalledWith({ runtime: runtimeB, model: "shared-model" });
    expect(JSON.stringify(body)).not.toContain("fingerprint");
    expect(JSON.stringify(body)).not.toContain("private");
    expect(JSON.stringify(body)).not.toContain(runtimeA.endpoint.baseUrl);
  });

  it("denies the agent principal before certification", async () => {
    const result = await call("POST", "/api/local-runtimes/certify", {
      runtimeId: OLLAMA_RT.id, model: "qwen3.6:27b",
    }, "agent");
    expect(result.status).toBe(403);
    expect(vi.mocked(certifyLocalModel)).not.toHaveBeenCalled();
  });

  it("rejects unknown runtime and model without refresh or certification", async () => {
    expect((await call("POST", "/api/local-runtimes/certify", {
      runtimeId: "missing", model: "qwen3.6:27b",
    })).status).toBe(404);
    expect((await call("POST", "/api/local-runtimes/certify", {
      runtimeId: OLLAMA_RT.id, model: "missing",
    })).status).toBe(404);
    expect(vi.mocked(certifyLocalModel)).not.toHaveBeenCalled();
    expect(vi.mocked(refreshLocalRuntimes)).not.toHaveBeenCalled();
  });

  it("reports non-reusable identity without publishing or blocking the request", async () => {
    vi.mocked(certifyLocalModel).mockImplementationOnce(async ({ runtime, model }) => (
      certificationResult(runtime, model, false)
    ));
    const result = await call("POST", "/api/local-runtimes/certify", {
      runtimeId: OLLAMA_RT.id, model: "qwen3.6:27b",
    });
    expect(result.status).toBe(200);
    expect(result.json()).toMatchObject({ ok: false, status: "identity_unavailable" });
  });

  it("reports a reusable failed scenario without changing availability", async () => {
    vi.mocked(certifyLocalModel).mockImplementationOnce(async ({ runtime, model }) => {
      const result = certificationResult(runtime, model);
      result.scenarios.required_tool_call = {
        passed: false, calls: 1, latencyMs: 2, failure: "missing_tool_call",
      };
      result.passedCount -= 1;
      return result;
    });
    const result = await call("POST", "/api/local-runtimes/certify", {
      runtimeId: OLLAMA_RT.id, model: "qwen3.6:27b",
    });
    expect(result.status).toBe(200);
    expect(result.json()).toMatchObject({ ok: false, status: "failed", passedCount: 4 });
  });

  it("keeps POST and subsequent GET unverified after a prior pass fails on retry", async () => {
    const first = await call("POST", "/api/local-runtimes/certify", {
      runtimeId: OLLAMA_RT.id, model: "qwen3.6:27b",
    });
    expect(first.json()).toMatchObject({ ok: true, status: "verified" });

    vi.mocked(certifyLocalModel).mockImplementationOnce(async ({ runtime, model }) => {
      publishedRuntime = null;
      publishedModel = "";
      const result = certificationResult(runtime, model);
      for (const id of CERTIFICATION_SCENARIOS) {
        result.scenarios[id] = { passed: false, calls: 1, latencyMs: 2, failure: "missing_marker" };
      }
      result.passedCount = 0;
      return result;
    });
    const retry = await call("POST", "/api/local-runtimes/certify", {
      runtimeId: OLLAMA_RT.id, model: "qwen3.6:27b",
    });
    expect(retry.json()).toMatchObject({ ok: false, status: "failed", passedCount: 0 });

    const read = await call("GET", "/api/local-runtimes");
    const body = read.json() as { runtimes: Array<{ id: string; models: Array<{ id: string; certification: { status: string } }> }> };
    const model = body.runtimes.find((runtime) => runtime.id === OLLAMA_RT.id)!
      .models.find((candidate) => candidate.id === "qwen3.6:27b")!;
    expect(model.certification.status).toBe("unverified");
  });

  it("sanitizes runner errors", async () => {
    vi.mocked(certifyLocalModel).mockRejectedValueOnce(new Error("secret token abc at http://private-host"));
    const result = await call("POST", "/api/local-runtimes/certify", {
      runtimeId: OLLAMA_RT.id, model: "qwen3.6:27b",
    });
    expect(result.status).toBe(500);
    expect(result.json()).toEqual({ ok: false, status: "error", error: "Verification failed" });
  });
});

describe("local-runtime certification read status", () => {
  it("is synchronous publication state and never starts certification", async () => {
    publishedRuntime = OLLAMA_RT;
    publishedModel = "qwen3.6:27b";
    const result = await call("GET", "/api/local-runtimes");
    const body = result.json() as {
      runtimes: Array<{ id: string; models: Array<{ id: string; certification: { status: string } }> }>;
    };
    const ollama = body.runtimes.find((runtime) => runtime.id === OLLAMA_RT.id)!;
    expect(ollama.models.find((model) => model.id === "qwen3.6:27b")?.certification.status).toBe("verified");
    expect(ollama.models.find((model) => model.id === "mxbai-embed-large:latest")?.certification.status).toBe("unverified");
    expect(vi.mocked(certifyLocalModel)).not.toHaveBeenCalled();
    expect(vi.mocked(refreshLocalRuntimes)).not.toHaveBeenCalled();

    const providersResult = await call("GET", "/api/providers");
    const providersBody = providersResult.json() as {
      providers: Array<{ id: string; runtimes?: Array<{ models: Array<{ id: string; certification: { status: string } }> }> }>;
    };
    const providerModel = providersBody.providers.find((provider) => provider.id === "local")
      ?.runtimes?.find((runtime) => runtime.models.some((model) => model.id === "qwen3.6:27b"))
      ?.models.find((model) => model.id === "qwen3.6:27b");
    expect(providerModel?.certification.status).toBe("verified");
    expect(vi.mocked(certifyLocalModel)).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/local-runtimes", () => {
  it("denies non-operators before persistence, refresh, or broadcast", async () => {
    settingsBag = { localRuntimes: [{ kind: "ollama", baseUrl: "http://127.0.0.1:5000" }] };
    const result = await call("DELETE", "/api/local-runtimes?baseUrl=http://127.0.0.1:5000", undefined, "readonly");
    expect(result.status).toBe(403);
    expect(result.json()).toEqual({ error: "Operator access required" });
    expect(savedSettings).toHaveLength(0);
    expect(vi.mocked(invalidateLocalRuntimes)).not.toHaveBeenCalled();
    expect(vi.mocked(refreshLocalRuntimes)).not.toHaveBeenCalled();
    expect(broadcastAll).not.toHaveBeenCalled();
  });

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

describe("POST /api/ollama/start", () => {
  it("denies non-operators before starting a process", async () => {
    const result = await call("POST", "/api/ollama/start", undefined, "user");
    expect(result.status).toBe(403);
    expect(result.json()).toEqual({ error: "Operator access required" });
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(savedSettings).toHaveLength(0);
    expect(vi.mocked(invalidateLocalRuntimes)).not.toHaveBeenCalled();
    expect(vi.mocked(refreshLocalRuntimes)).not.toHaveBeenCalled();
    expect(broadcastAll).not.toHaveBeenCalled();
  });
});
