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

  // The auto-pull invariant. Regression 2026-07-23: a broken Settings
  // dropdown saved "gpt-oss:120b" as embeddingModel; boot silently pulled
  // 65GB and pre-warmed a 120B chat model, saturating VRAM and wedging
  // live chat turns. The warmer must never pull OR use a model it cannot
  // justify as an embedder.
  it("refuses to auto-pull a target that is not a recognized embedding model", () => {
    const decision = decideEmbeddingModelAction("gpt-oss:120b", {
      reachable: true,
      models: [{ name: "llama3:8b" }],
    });
    expect(decision.action).toBe("refuse");
  });

  it("refuses to USE an installed model the runtime reports as chat-capable when its name matches no embedding family", () => {
    const decision = decideEmbeddingModelAction("gpt-oss:120b", {
      reachable: true,
      models: [{ name: "gpt-oss:120b" }],
    });
    expect(decision.action).toBe("refuse");
  });

  it("uses an installed odd-named model when the runtime authoritatively flags it embedding-only", () => {
    // Custom embedders with unrecognized names stay usable — the runtime's
    // capabilities flag is the authority; the name regex is only a backstop.
    const decision = decideEmbeddingModelAction("my-custom-vectors:1b", {
      reachable: true,
      models: [{ name: "my-custom-vectors:1b", embeddingOnly: true }],
    });
    expect(decision).toEqual({ action: "use" });
  });

  it("embedding-family names still pull when missing and use when installed (flag absent on older Ollama)", () => {
    expect(decideEmbeddingModelAction("nomic-embed-text", { reachable: true, models: [] }).action).toBe("pull");
    expect(decideEmbeddingModelAction("nomic-embed-text", {
      reachable: true,
      models: [{ name: "nomic-embed-text:latest" }],
    })).toEqual({ action: "use" });
  });
});
