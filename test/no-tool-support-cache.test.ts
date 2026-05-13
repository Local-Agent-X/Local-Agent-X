/**
 * Pins the (baseURL, model) keying of the no-tool-support cache (P5.C2,
 * AUDIT Critical #4).
 *
 * Before this fix the cache was keyed by model name alone: a "doesn't
 * support tools" finding from one endpoint (e.g. local Ollama) poisoned
 * every other endpoint serving the same model name (e.g. Ollama Turbo
 * cloud, which DOES support tools). Both providers/adapters/openai-http.ts
 * (legacy → still reached by canonical-loop via OllamaHttpAdapter) and
 * canonical-loop/adapters/openai-compat.ts (canonical retry path) share
 * the same cache module.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  hasNoToolSupport,
  markNoToolSupport,
  _resetNoToolSupportForTests,
} from "../src/providers/types.js";

describe("no-tool-support cache — (baseURL, model) keying", () => {
  beforeEach(() => _resetNoToolSupportForTests());

  it("a mark for one baseURL does NOT poison another baseURL with the same model", () => {
    markNoToolSupport("http://127.0.0.1:11434/v1", "qwen2:7b");
    expect(hasNoToolSupport("http://127.0.0.1:11434/v1", "qwen2:7b")).toBe(true);
    // Cloud endpoint that DOES support tools for the same model name must
    // remain uncached — this is the bug the audit Critical #4 flagged.
    expect(hasNoToolSupport("https://ollama.com/v1", "qwen2:7b")).toBe(false);
  });

  it("a mark for one model does NOT poison another model on the same baseURL", () => {
    markNoToolSupport("http://127.0.0.1:11434/v1", "qwen2:7b");
    expect(hasNoToolSupport("http://127.0.0.1:11434/v1", "qwen2:7b")).toBe(true);
    expect(hasNoToolSupport("http://127.0.0.1:11434/v1", "llama3:8b")).toBe(false);
  });

  it("calls are idempotent — marking twice is the same as marking once", () => {
    markNoToolSupport("http://127.0.0.1:11434/v1", "qwen2:7b");
    markNoToolSupport("http://127.0.0.1:11434/v1", "qwen2:7b");
    expect(hasNoToolSupport("http://127.0.0.1:11434/v1", "qwen2:7b")).toBe(true);
  });

  it("undefined baseURL is treated as its own key (caller hasn't supplied one)", () => {
    // The dispatcher passes baseURL=undefined for providers that don't
    // configure one. We don't want undefined to collide across providers
    // OR with a real baseURL.
    markNoToolSupport(undefined, "some-model");
    expect(hasNoToolSupport(undefined, "some-model")).toBe(true);
    expect(hasNoToolSupport("http://127.0.0.1:11434/v1", "some-model")).toBe(false);
  });

  it("starts empty after reset (state doesn't leak between tests)", () => {
    expect(hasNoToolSupport("http://127.0.0.1:11434/v1", "qwen2:7b")).toBe(false);
  });
});
