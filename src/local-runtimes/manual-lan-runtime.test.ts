/**
 * C7 end-to-end: a manually-added NON-LOOPBACK runtime entry flows the whole
 * routing chain — candidateEndpoints → admission → discovery (detect /
 * listModels / probeModel) → cache → getRuntimeForModel → the chat baseURL
 * the canonical loop dials (resolve-target.ts "local" branch) — with fetch
 * fully mocked. No real network: every wire call goes through the stubbed
 * global fetch, which answers ONLY for the operator-named LAN endpoint and
 * refuses everything else (so the loopback sweep candidates just drop out).
 *
 * The discovery sweep's VITEST guard exists to stop LIVE loopback I/O in
 * tests; here fetch itself is stubbed, so the guard is lifted for this file
 * only (env stubs, restored in afterAll) to let the real sweep code run.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const settingsState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:11434", port: 7007 }),
}));
vi.mock("../settings.js", () => ({
  settingsPath: () => "unused-in-test",
  loadSettings: () => settingsState.current,
  reloadSettings: () => settingsState.current,
  getSetting: (key: string) => settingsState.current[key],
  saveSettings: () => {},
  setSetting: () => {},
}));
// The autostart helper's real-deps path spawns processes and its inertness
// guard reads the same env this file clears — keep it inert explicitly.
vi.mock("./lmstudio-autostart.js", () => ({
  maybeAutostartLmStudio: async () => false,
  lmStudioAutoStartedAt: () => null,
}));

import { candidateEndpoints } from "./endpoints.js";
import {
  refreshLocalRuntimes,
  getLocalRuntimes,
  getRuntimeForModel,
  invalidateLocalRuntimes,
} from "./cache.js";
import { resolveOpenAICompatTarget } from "../canonical-loop/public/resolve-target.js";

const LAN = "http://192.168.1.50:11434";

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input);
  if (url.startsWith(LAN)) {
    if (url.endsWith("/api/version")) return jsonRes({ version: "0.32.1" });
    if (url.endsWith("/api/tags")) {
      return jsonRes({
        models: [{
          name: "qwen3:32b",
          size: 20_000_000_000,
          modified_at: "2026-07-01T00:00:00Z",
          capabilities: ["completion", "tools"],
        }],
      });
    }
    if (url.endsWith("/api/ps")) {
      return jsonRes({ models: [{ name: "qwen3:32b", context_length: 32768 }] });
    }
    if (url.endsWith("/api/show")) {
      return jsonRes({ parameters: "num_ctx  32768", capabilities: ["completion", "tools"] });
    }
  }
  // Everything else (the loopback sweep) is refused — nothing else is up.
  throw new TypeError("fetch failed (connection refused)");
});

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "development");
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("manual LAN runtime — candidateEndpoints → admission (C7)", () => {
  it("with no manual entries the sweep is loopback-only (the standing invariant)", () => {
    settingsState.current = {};
    for (const c of candidateEndpoints()) {
      expect(c.endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1[:/]/);
    }
  });

  it("an operator entry admits EXACTLY its host:port and nothing else non-loopback", () => {
    settingsState.current = {
      localRuntimes: [{ kind: "ollama", baseUrl: LAN, label: "GPU box" }],
    };
    const cands = candidateEndpoints();
    const lan = cands.filter((c) => !c.endpoint.baseUrl.startsWith("http://127.0.0.1"));
    expect(lan).toHaveLength(1);
    expect(lan[0]).toMatchObject({
      kind: "ollama",
      label: "GPU box",
      endpoint: { baseUrl: LAN, origin: "manual" },
    });
  });
});

describe("manual LAN runtime — discovery → cache → chat routing (C7)", () => {
  it("flows detect → listModels → probeModel → getRuntimeForModel → resolve-target baseURL", async () => {
    settingsState.current = {
      localRuntimes: [{ kind: "ollama", baseUrl: LAN, label: "GPU box" }],
    };
    invalidateLocalRuntimes();

    const found = await refreshLocalRuntimes();
    expect(getLocalRuntimes()).toBe(found);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "ollama",
      id: "ollama@192.168.1.50:11434",
      label: "GPU box",
      chatBaseUrl: `${LAN}/v1`,
      endpoint: { baseUrl: LAN, origin: "manual" },
    });
    // Deep probe facts made it through: served context + tool capability.
    expect(found[0].models).toEqual([
      expect.objectContaining({ id: "qwen3:32b", contextWindow: 32768, tools: true }),
    ]);

    // Per-turn lookup finds the LAN runtime for its model...
    expect(getRuntimeForModel("qwen3:32b")?.id).toBe("ollama@192.168.1.50:11434");
    // ...and an unknown model routes nowhere (no accidental catch-all).
    expect(getRuntimeForModel("no-such-model")).toBeNull();

    // The canonical chat path resolves the SAME baseURL the runtime declared —
    // resolve-target.ts's "local" branch, the one place chat picks an endpoint.
    const target = await resolveOpenAICompatTarget("local", { apiKey: "" }, "qwen3:32b");
    expect(target).toMatchObject({
      baseURL: `${LAN}/v1`,
      apiKey: "ollama",
      modelProfile: {
        runtimeId: "ollama@192.168.1.50:11434",
        baseURL: `${LAN}/v1`,
        model: "qwen3:32b",
        tier: "medium",
        contextWindow: 32768,
        tools: { advertised: true, verified: null, rejectsTools: false },
      },
    });

    // No unnamed non-loopback host was ever dialed — every wire call in the
    // sweep hit either loopback (refused) or the operator-named endpoint.
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(
        url.startsWith("http://127.0.0.1") || url.startsWith(LAN),
      ).toBe(true);
    }
  });
});
