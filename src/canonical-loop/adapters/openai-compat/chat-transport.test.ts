/**
 * Wire contract: which transport carries an openai-compat request. Native
 * /api/chat for a discovered LOCAL Ollama runtime only; Chat Completions for
 * Ollama Cloud, LM Studio / vLLM / llama.cpp, an Ollama URL discovery never
 * confirmed, and every cloud provider.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalRuntimeInfo } from "../../../local-runtimes/types.js";

const nativeStream = vi.fn(async function* () { yield { type: "done" as const, stopReason: "stop" }; });
const httpStream = vi.fn(async function* () { yield { type: "done" as const, stopReason: "stop" }; });
vi.mock("../../../providers/adapters/ollama-native.js", () => ({ ollamaNativeAdapter: { stream: nativeStream } }));
vi.mock("../../../providers/adapters/openai-http.js", () => ({ openaiHttpAdapter: { stream: httpStream } }));

const { chatTransportName } = await import("./chat-transport.js");
const { streamOnce } = await import("./stream-once.js");
const { invalidateLocalRuntimes, restoreProjectedLocalRuntime } = await import("../../../local-runtimes/cache.js");
const { PROVIDERS, isHttpProvider } = await import("../../../providers/registry.js");
const { PROVIDER_IDS } = await import("../../../providers/provider-ids.js");

let dir: string;

function discover(runtime: Partial<LocalRuntimeInfo> & Pick<LocalRuntimeInfo, "kind" | "endpoint">): void {
  const file = join(dir, `${Math.random()}.json`);
  writeFileSync(file, JSON.stringify({
    id: `${runtime.kind}@x`, label: runtime.kind, chatBaseUrl: `${runtime.endpoint.baseUrl}/v1`,
    models: [{ id: "m", contextWindow: null, tools: null }], refreshedAt: 1, ...runtime,
  }));
  restoreProjectedLocalRuntime(file);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-transport-"));
  nativeStream.mockClear();
  httpStream.mockClear();
});

afterEach(() => {
  invalidateLocalRuntimes();
  rmSync(dir, { recursive: true, force: true });
});

describe("chatTransportName", () => {
  it("a discovered local Ollama rides native /api/chat", async () => {
    discover({ kind: "ollama", endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" } });
    expect(await chatTransportName("http://127.0.0.1:11434/v1")).toBe("ollama-native");
  });

  it("a manually added LAN Ollama is still Ollama: native", async () => {
    discover({ kind: "ollama", endpoint: { baseUrl: "http://192.168.1.50:11434", origin: "manual" } });
    expect(await chatTransportName("http://192.168.1.50:11434/v1")).toBe("ollama-native");
  });

  it("LM Studio, vLLM and llama.cpp (openai-compat runtimes) stay on /v1", async () => {
    discover({ kind: "openai-compat", endpoint: { baseUrl: "http://127.0.0.1:1234", origin: "auto" } });
    expect(await chatTransportName("http://127.0.0.1:1234/v1")).toBe("openai-http");
  });

  it("an Ollama URL discovery never confirmed (config.ollamaUrl fallback) stays on /v1", async () => {
    expect(await chatTransportName("http://127.0.0.1:11434/v1")).toBe("openai-http");
  });

  it("Ollama Cloud and every cloud provider stay on /v1", async () => {
    discover({ kind: "ollama", endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" } });
    const cloud = ["https://ollama.com/v1", "https://ollama.com/api", undefined];
    for (const id of PROVIDER_IDS) {
      const meta = PROVIDERS[id];
      if (isHttpProvider(meta) && typeof meta.baseURL === "string") cloud.push(meta.baseURL);
    }
    expect(cloud.length).toBeGreaterThan(4);
    for (const url of cloud) expect(await chatTransportName(url), String(url)).toBe("openai-http");
  });
});

describe("streamOnce routes through the selected transport", () => {
  const request = (baseURL: string) => ({
    apiKey: "k", model: "m", baseURL, systemPrompt: "s", messages: [], tools: [],
  });

  it("native for the discovered Ollama, Chat Completions otherwise", async () => {
    discover({ kind: "ollama", endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" } });
    await streamOnce(request("http://127.0.0.1:11434/v1"), () => {}, { isAborted: () => false });
    expect(nativeStream).toHaveBeenCalledTimes(1);
    expect(httpStream).not.toHaveBeenCalled();
    await streamOnce(request("https://api.openai.com/v1"), () => {}, { isAborted: () => false });
    expect(httpStream).toHaveBeenCalledTimes(1);
  });
});
