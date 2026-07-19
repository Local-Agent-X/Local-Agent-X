import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CertifiedLocalClassifierTarget } from "../src/local-runtimes/classifier-model.js";

const state = vi.hoisted(() => ({
  certifiedTarget: null as CertifiedLocalClassifierTarget | null,
  targetCurrent: true,
  targetChecks: [] as boolean[],
  discoveredModel: null as string | null,
  pinnedModel: "",
}));

vi.mock("../src/providers/resolve-provider-context.js", () => ({
  resolveProviderContext: async () => ({
    provider: "local",
    apiKey: "ollama",
    model: "chat:27b",
  }),
}));

vi.mock("../src/settings.js", () => ({
  getSetting: () => state.pinnedModel,
}));

vi.mock("../src/config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:11434" }),
}));

vi.mock("../src/local-runtimes/index.js", () => ({
  pickCertifiedLocalClassifierTarget: () => state.certifiedTarget,
  pickLocalClassifierModel: () => state.discoveredModel,
  isCertifiedLocalClassifierTargetCurrent: () => state.targetChecks.shift() ?? state.targetCurrent,
}));

import { classifyWithLLM } from "../src/classifiers/classify-with-llm.js";
import { dispatch } from "../src/llm-dispatch.js";

const OPENAI_TARGET: CertifiedLocalClassifierTarget = {
  runtimeId: "openai-compat@127.0.0.1:1234",
  kind: "openai-compat",
  endpointBaseUrl: "http://127.0.0.1:1234",
  chatBaseUrl: "http://127.0.0.1:1234/v1",
  model: "shared:3b",
};

const SECOND_OLLAMA_TARGET: CertifiedLocalClassifierTarget = {
  runtimeId: "ollama@127.0.0.1:22434",
  kind: "ollama",
  endpointBaseUrl: "http://127.0.0.1:22434",
  chatBaseUrl: "http://127.0.0.1:22434/v1",
  model: "small:3b",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function classify(): Promise<string | null> {
  return classifyWithLLM({
    category: "local-target-route",
    systemPrompt: "Reply OK.",
    userPrompt: "route proof",
    timeoutMs: 1_000,
    parse: (raw) => raw === "OK" ? raw : null,
  });
}

beforeEach(() => {
  state.certifiedTarget = null;
  state.targetCurrent = true;
  state.targetChecks = [];
  state.discoveredModel = null;
  state.pinnedModel = "";
  vi.restoreAllMocks();
});

describe("certified local background endpoint ownership", () => {
  it("routes a duplicate model ID to its certified OpenAI-compatible runtime", async () => {
    state.certifiedTarget = OPENAI_TARGET;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer ollama");
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe("shared:3b");
      return jsonResponse({ choices: [{ message: { content: "OK" } }] });
    });

    await expect(classify()).resolves.toBe("OK");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(":11434"))).toBe(false);
  });

  it("uses the exact second Ollama root and its native generate protocol", async () => {
    state.certifiedTarget = SECOND_OLLAMA_TARGET;
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/ps")) {
        return jsonResponse({ models: [{ name: "small:3b" }] });
      }
      expect(url).toBe("http://127.0.0.1:22434/api/generate");
      return jsonResponse({ response: "OK" });
    });

    await expect(classify()).resolves.toBe("OK");
    expect(urls).toEqual([
      "http://127.0.0.1:22434/api/ps",
      "http://127.0.0.1:22434/api/generate",
    ]);
    expect(urls.some((url) => url.includes(":11434"))).toBe(false);
  });

  it("does not cross to default Ollama when an exact target goes stale before dispatch", async () => {
    state.certifiedTarget = OPENAI_TARGET;
    state.targetChecks = [true, false];
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(classify()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow an OpenAI-compatible redirect to another origin", async () => {
    let destinationHits = 0;
    const destination = createServer((_request, response) => {
      destinationHits += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    });
    const destinationPort = await listen(destination);
    let originHits = 0;
    const origin = createServer((_request, response) => {
      originHits += 1;
      response.writeHead(302, { Location: `http://127.0.0.1:${destinationPort}/captured` });
      response.end();
    });
    const originPort = await listen(origin);
    state.certifiedTarget = {
      ...OPENAI_TARGET,
      runtimeId: `openai-compat@127.0.0.1:${originPort}`,
      endpointBaseUrl: `http://127.0.0.1:${originPort}`,
      chatBaseUrl: `http://127.0.0.1:${originPort}/v1`,
    };
    try {
      await expect(classify()).resolves.toBeNull();
      expect(originHits).toBe(1);
      expect(destinationHits).toBe(0);
    } finally {
      await close(origin);
      await close(destination);
    }
  });

  it("does not follow native Ollama redirects for residency or generation", async () => {
    let destinationHits = 0;
    const destination = createServer((_request, response) => {
      destinationHits += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ response: "OK", models: [{ name: "small:3b" }] }));
    });
    const destinationPort = await listen(destination);
    const originPaths: string[] = [];
    const origin = createServer((request, response) => {
      originPaths.push(request.url ?? "");
      response.writeHead(302, { Location: `http://127.0.0.1:${destinationPort}/captured` });
      response.end();
    });
    const originPort = await listen(origin);
    state.certifiedTarget = {
      ...SECOND_OLLAMA_TARGET,
      runtimeId: `ollama@127.0.0.1:${originPort}`,
      endpointBaseUrl: `http://127.0.0.1:${originPort}`,
      chatBaseUrl: `http://127.0.0.1:${originPort}/v1`,
    };
    try {
      await expect(classify()).resolves.toBeNull();
      expect(originPaths).toEqual(["/api/ps", "/api/generate"]);
      expect(destinationHits).toBe(0);
    } finally {
      await close(origin);
      await close(destination);
    }
  });

  it("preserves existing default-Ollama routing without certified evidence", async () => {
    state.discoveredModel = "small:3b";
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/ps")) {
        return jsonResponse({ models: [{ name: "small:3b" }] });
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe("small:3b");
      return jsonResponse({ response: "OK" });
    });

    await expect(classify()).resolves.toBe("OK");
    expect(urls).toEqual([
      "http://127.0.0.1:11434/api/ps",
      "http://127.0.0.1:11434/api/generate",
    ]);
  });

  it("keeps a model-only pin on default Ollama instead of guessing an endpoint", async () => {
    state.pinnedModel = "pinned:1b";
    state.certifiedTarget = OPENAI_TARGET;
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/ps")) {
        return jsonResponse({ models: [{ name: "pinned:1b" }] });
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe("pinned:1b");
      return jsonResponse({ response: "OK" });
    });

    await expect(classify()).resolves.toBe("OK");
    expect(urls).toEqual([
      "http://127.0.0.1:11434/api/ps",
      "http://127.0.0.1:11434/api/generate",
    ]);
    expect(urls.some((url) => url.includes(":1234"))).toBe(false);
  });

  it("refuses a stale target or a model that does not match its certification", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(dispatch({
      prompt: "route proof",
      provider: "local",
      ollamaModel: "other:3b",
      localTarget: { ...SECOND_OLLAMA_TARGET, apiKey: "ollama" },
    })).resolves.toBeNull();
    state.targetCurrent = false;
    await expect(dispatch({
      prompt: "route proof",
      provider: "local",
      ollamaModel: SECOND_OLLAMA_TARGET.model,
      localTarget: { ...SECOND_OLLAMA_TARGET, apiKey: "ollama" },
    })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
