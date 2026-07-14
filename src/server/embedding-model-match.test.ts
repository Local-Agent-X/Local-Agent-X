import { describe, it, expect } from "vitest";
import { embeddingModelInstalled, decideEmbeddingModelAction } from "./embedding-model-match.js";

describe("embeddingModelInstalled", () => {
  it("bare target matches an installed model with an explicit non-latest tag (:335m)", () => {
    // Regression: old code stripped only ":latest", so "mxbai-embed-large:335m"
    // never matched the bare target and got re-pulled (~670MB) on every boot.
    expect(embeddingModelInstalled("mxbai-embed-large", ["mxbai-embed-large:335m"])).toBe(true);
  });

  it("bare target matches an installed :latest model", () => {
    expect(embeddingModelInstalled("mxbai-embed-large", ["mxbai-embed-large:latest"])).toBe(true);
  });

  it("bare target matches a bare installed name", () => {
    expect(embeddingModelInstalled("nomic-embed-text", ["nomic-embed-text"])).toBe(true);
  });

  it("explicit :335m target does NOT match an installed :latest model", () => {
    expect(embeddingModelInstalled("mxbai-embed-large:335m", ["mxbai-embed-large:latest"])).toBe(false);
  });

  it("explicit :latest target matches a bare installed name (latest equivalence)", () => {
    expect(embeddingModelInstalled("mxbai-embed-large:latest", ["mxbai-embed-large"])).toBe(true);
  });

  it("does not match a different model or a base-name prefix", () => {
    expect(embeddingModelInstalled("mxbai-embed-large", ["nomic-embed-text:latest"])).toBe(false);
    expect(embeddingModelInstalled("mxbai-embed", ["mxbai-embed-large:335m"])).toBe(false);
  });

  it("returns false on an empty install list", () => {
    expect(embeddingModelInstalled("mxbai-embed-large", [])).toBe(false);
  });
});

describe("decideEmbeddingModelAction", () => {
  it("unreachable Ollama → retry, never pull (empty tag list means 'could not ask')", () => {
    // Regression: cold Ollama at app launch (3s probe timeout) must not be
    // treated as "model missing" — that triggered a ~670MB pull attempt
    // instead of letting warmEmbeddingsWithRetry's backoff re-probe.
    const decision = decideEmbeddingModelAction("mxbai-embed-large", { reachable: false, models: [] });
    expect(decision).toEqual({ action: "retry", reason: "ollama-unreachable" });
  });

  it("reachable with the model installed under :335m → use, no pull", () => {
    const decision = decideEmbeddingModelAction("mxbai-embed-large", {
      reachable: true,
      models: [{ name: "mxbai-embed-large:335m" }, { name: "llama3:8b" }],
    });
    expect(decision).toEqual({ action: "use" });
  });

  it("reachable but model genuinely missing → pull", () => {
    const decision = decideEmbeddingModelAction("mxbai-embed-large", {
      reachable: true,
      models: [{ name: "llama3:8b" }],
    });
    expect(decision).toEqual({ action: "pull" });
  });
});
