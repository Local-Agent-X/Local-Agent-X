import { describe, expect, it } from "vitest";
import { resolveBuildModel } from "../src/tools/build-app.js";
import { PROVIDERS } from "../src/providers/registry.js";

/**
 * Regression guard (2026-07-15): resolveBuildModel validated the selected model
 * against PROVIDERS[p].models, but `local` and `ollama-cloud` ship an EMPTY
 * static list by design — their catalog comes from the src/local-runtimes/
 * discovery sweep. So `includes()` was unconditionally false for local and every
 * build silently fell back to PROVIDERS.local.defaultModel ("qwen2:7b"),
 * discarding the user's actual pick (live: "google/gemma-4-e4b" in settings.json).
 *
 * qwen2:7b is the model this codebase documents as the exemplar of returning
 * empty when sent tools — so the swap didn't just ignore the selection, it
 * substituted the one model most likely to fail the build outright.
 */
describe("resolveBuildModel — dynamic-catalog providers honor the selection", () => {
  it("keeps the user's selected local model instead of substituting qwen2:7b", () => {
    // The exact live case: settings.json had google/gemma-4-e4b selected.
    expect(resolveBuildModel("local", "google/gemma-4-e4b")).toBe("google/gemma-4-e4b");
  });

  it("keeps any discovered local model (LM Studio / vLLM / llama.cpp ids too)", () => {
    for (const model of ["qwen3.6:27b", "gpt-oss:120b", "google/gemma-4-e4b", "some-lmstudio-gguf"]) {
      expect(resolveBuildModel("local", model)).toBe(model);
    }
  });

  it("never silently returns the qwen2:7b default when a model IS selected", () => {
    // The specific failure: the fallback was reachable for every local build.
    expect(PROVIDERS.local.defaultModel).toBe("qwen2:7b"); // documents why this matters
    expect(resolveBuildModel("local", "qwen3.6:27b")).not.toBe("qwen2:7b");
  });

  it("honors selections for ollama-cloud too (the other empty-catalog provider)", () => {
    expect(resolveBuildModel("ollama-cloud", "kimi-k2:1t-cloud")).toBe("kimi-k2:1t-cloud");
  });

  it("guards the invariant this fix keys off: local/ollama-cloud catalogs are empty", () => {
    // If a static list ever gets populated, the emptiness rule stops firing and
    // the membership check silently governs again — fail loudly here instead.
    expect(PROVIDERS.local.models).toEqual([]);
    expect(PROVIDERS["ollama-cloud"].models).toEqual([]);
  });
});

describe("resolveBuildModel — static-catalog providers keep validating (no regression)", () => {
  it("passes through a model that IS in the provider's static list", () => {
    expect(resolveBuildModel("xai", "grok-code-fast-1")).toBe("grok-code-fast-1");
    expect(resolveBuildModel("anthropic", PROVIDERS.anthropic.models[0])).toBe(PROVIDERS.anthropic.models[0]);
  });

  it("still falls back to the default for a model NOT in a populated list", () => {
    // This is the behavior the function exists for: the Codex CLI's own default
    // is a retired model, so a bogus/stale selection must not reach it.
    expect(resolveBuildModel("codex", "gpt-5.3-codex-retired-nonsense")).toBe(PROVIDERS.codex.defaultModel);
    expect(resolveBuildModel("xai", "not-a-real-grok")).toBe(PROVIDERS.xai.defaultModel);
  });

  it("falls back to the default when nothing is selected", () => {
    expect(resolveBuildModel("xai", undefined)).toBe(PROVIDERS.xai.defaultModel);
    expect(resolveBuildModel("local", undefined)).toBe(PROVIDERS.local.defaultModel);
  });

  it("returns undefined for an unknown provider (unchanged)", () => {
    expect(resolveBuildModel("not-a-provider", "some-model")).toBeUndefined();
    expect(resolveBuildModel("not-a-provider", undefined)).toBeUndefined();
  });
});
