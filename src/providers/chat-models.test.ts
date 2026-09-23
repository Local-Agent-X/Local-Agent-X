// The settings model picker is GENERATED from this registry. It used to keep a
// hand-written copy in public/js/settings-providers.js, and that copy drifted:
// three Anthropic models behind, no gpt-6-astra on either OpenAI provider, no
// o3-pro (OpenAI's own defaultModel), and four OpenAI models the registry had
// dropped. The last one wasn't cosmetic — resolveBuildModel swaps any model
// absent from `models` for defaultModel, so the picker offered builds that
// silently ran on something else.
//
// These tests pin the generation seam so the copy can't come back.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PROVIDERS, chatModelsFor, providerRegistryView } from "./registry.js";
import type { ProviderId } from "./provider-ids.js";

describe("chatModelsFor — picker list derived from the registry", () => {
  it("returns the full model list for a provider with no exclusions", () => {
    expect(chatModelsFor("anthropic")).toEqual(PROVIDERS.anthropic.models);
    expect(chatModelsFor("gemini")).toEqual(PROVIDERS.gemini.models);
  });

  // grok-4.20-multi-agent-0309 is served over a deferred completion flow the
  // streaming chat adapter can't drive: real for routing, an error if picked
  // for chat. It stays in `models` and drops out of the picker.
  it("drops a chat-excluded model without removing it from the registry", () => {
    expect(PROVIDERS.xai.models).toContain("grok-4.20-multi-agent-0309");
    expect(chatModelsFor("xai")).not.toContain("grok-4.20-multi-agent-0309");
    expect(chatModelsFor("xai")).toContain("grok-4.5");
  });

  it("never hands back the registry's own array to mutate", () => {
    expect(chatModelsFor("anthropic")).not.toBe(PROVIDERS.anthropic.models);
  });

  // Every provider's defaultModel must be pickable, or the UI can't show the
  // model the agent actually runs. openai shipped with o3-pro as its default
  // while the hand-written picker omitted it entirely.
  it.each(Object.keys(PROVIDERS) as ProviderId[])(
    "%s: defaultModel is offered in the picker",
    (id) => {
      const def = PROVIDERS[id].defaultModel;
      if (!def || PROVIDERS[id].models.length === 0) return;
      expect(chatModelsFor(id)).toContain(def);
    },
  );

  it("exposes chatModels on the wire view alongside the raw list", () => {
    const view = providerRegistryView("xai");
    expect(view.models).toContain("grok-4.20-multi-agent-0309");
    expect(view.chatModels).not.toContain("grok-4.20-multi-agent-0309");
    expect(view.defaultModel).toBe(PROVIDERS.xai.defaultModel);
  });
});

describe("the settings picker holds no model list of its own", () => {
  const ui = readFileSync(new URL("../../public/js/settings-providers.js", import.meta.url), "utf8");

  it("does not reintroduce a hardcoded PROVIDER_MODELS table", () => {
    expect(ui).not.toMatch(/const PROVIDER_MODELS\s*=/);
  });

  // The drift was only possible because model ids were spelled in the UI at
  // all. If one reappears, someone is hand-listing models again.
  it("spells no concrete model id in the settings UI", () => {
    const ids = ui.match(/['"](?:claude|gpt|grok|gemini|o[34])[\w.-]*['"]/g) ?? [];
    expect(ids).toEqual([]);
  });

  it("reads the picker list from the provider registry", () => {
    expect(ui).toMatch(/laxProviderChatModelOptions\(await laxProviderRegistry\(\)/);
  });
});

describe("Claude Fable 5.1", () => {
  it("is selectable, and Fable 5 stays available as legacy", () => {
    expect(chatModelsFor("anthropic")).toContain("claude-fable-5-1");
    expect(chatModelsFor("anthropic")).toContain("claude-fable-5");
  });
});
