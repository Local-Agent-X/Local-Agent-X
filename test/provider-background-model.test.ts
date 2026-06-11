import { describe, expect, it } from "vitest";
import { PROVIDERS, backgroundModelFor } from "../src/providers/registry.js";
import { PROVIDER_IDS } from "../src/providers/provider-ids.js";

describe("provider backgroundModel", () => {
  // Background models the provider serves but deliberately does NOT offer for
  // interactive chat. gemini: flash models empty out on LAX's full chat prompt
  // (so they're not in `models`), but background agents use compact prompts —
  // see the gemini entry in providers/registry.ts. Anything else landing here
  // needs the same kind of documented justification.
  const OUT_OF_LIST_BACKGROUND: Record<string, string> = {
    gemini: "gemini-2.0-flash",
  };

  it("every configured backgroundModel is a model the provider lists (or a documented background-only pick)", () => {
    // A backgroundModel the provider can't serve would fail at call time —
    // catch the typo here, not in a silently-cancelled dream at 3am.
    for (const id of PROVIDER_IDS) {
      const meta = PROVIDERS[id];
      if (!meta.backgroundModel) continue;
      // Some providers (local, ollama-cloud) populate models dynamically and
      // ship an empty static list; skip the membership check there.
      if (meta.models.length === 0) continue;
      if (OUT_OF_LIST_BACKGROUND[id] === meta.backgroundModel) continue;
      expect(meta.models, `${id}.backgroundModel`).toContain(meta.backgroundModel);
    }
  });

  it("backgroundModelFor returns the configured model, else the fallback", () => {
    expect(backgroundModelFor("xai", "grok-4.3")).toBe("grok-4.20-0309-non-reasoning");
    expect(backgroundModelFor("openai", "o3-pro")).toBe("gpt-4o-mini");
    expect(backgroundModelFor("anthropic", "claude-opus-4-8")).toBe("claude-haiku-4-5");
    // Provider without a backgroundModel falls through to the caller's default.
    expect(backgroundModelFor("local", "qwen2:7b")).toBe("qwen2:7b");
  });

  it("the OpenAI background model is non-reasoning (no hidden-think watchdog stall)", () => {
    // The whole point on OpenAI: o-series hides reasoning server-side, so a
    // long think streams nothing and the idle watchdog can't tell it from a
    // hang. The background pick must NOT be a reasoning model.
    const bg = PROVIDERS.openai.backgroundModel!;
    expect(PROVIDERS.openai.capabilities.reasoning).not.toBe(false);
    expect((PROVIDERS.openai.capabilities.reasoning as RegExp).test(bg)).toBe(false);
  });
});
