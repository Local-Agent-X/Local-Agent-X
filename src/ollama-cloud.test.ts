import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLocalOllamaTags, refreshLocalOllama } from "./ollama-cloud.js";

/**
 * Cross-seam contract: fetchLocalOllamaTags is the shared source for BOTH
 * chat-facing consumers (providers route default view, refreshLocalOllama's
 * cache) AND embedding-facing consumers (the Settings embedding dropdown via
 * /api/models/local?include=embeddings, the boot-time embedding warmer,
 * setup-status). Regression 6e27ff0f made it delegate to the ollama probe,
 * which then DROPPED embedding-only models at list time — blinding every
 * embedding consumer: the Settings dropdown showed only chat models and
 * auto-saved gpt-oss:120b (65GB) as embeddingModel, and the boot warmer
 * re-pulled installed embedders forever because they "weren't in tags".
 * This pins the contract: embedders come back MARKED, never dropped.
 */

const OLLAMA_URL = "http://127.0.0.1:11434";

function stubOllama(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/version")) {
      return new Response(JSON.stringify({ version: "0.32.0" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [
        { name: "qwen3.6:27b", size: 17e9, modified_at: "2026-07-15", capabilities: ["completion", "tools"] },
        { name: "mxbai-embed-large:latest", size: 669e6, modified_at: "2026-07-15", capabilities: ["embedding"] },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchLocalOllamaTags embedding-model contract", () => {
  it("surfaces embedding-only models, marked — embedding consumers must be able to see them", async () => {
    stubOllama();
    const { reachable, models } = await fetchLocalOllamaTags(OLLAMA_URL);
    expect(reachable).toBe(true);
    expect(models.map(m => m.name)).toEqual(["qwen3.6:27b", "mxbai-embed-large:latest"]);
    expect(models.find(m => m.name === "mxbai-embed-large:latest")?.embeddingOnly).toBe(true);
    expect(models.find(m => m.name === "qwen3.6:27b")?.embeddingOnly).toBeUndefined();
  });

  it("refreshLocalOllama's chat-facing cache still excludes embedders", async () => {
    stubOllama();
    const state = await refreshLocalOllama(OLLAMA_URL);
    expect(state.reachable).toBe(true);
    expect(state.models).toEqual(["qwen3.6:27b"]);
  });
});
