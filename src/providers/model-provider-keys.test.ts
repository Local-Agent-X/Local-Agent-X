// A model-provider key is one the agent could run on itself; asking the user
// for one to do the agent's own generating is the mistake this classifier
// exists to name (2026-10-31: an Anthropic key requested to write recipes).
import { describe, expect, it } from "vitest";
import { AUTH_PROVIDERS } from "../auth/auth-provider.js";
import { modelProviderKeyGuidance, modelProviderKeyNotice, modelProviderOfSecret } from "./model-provider-keys.js";

describe("modelProviderOfSecret", () => {
  // The vault names the agent's own credential resolver reads: a key saved
  // under one of these can run the agent, so each must be recognized.
  it("recognizes every vault key name the agent's own providers read", () => {
    const own = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY", "OLLAMA_CLOUD_API_KEY"];
    for (const name of own) expect(modelProviderOfSecret(name), name).not.toBeNull();
    expect(Object.keys(AUTH_PROVIDERS)).toEqual(expect.arrayContaining(["anthropic-api", "openai", "xai", "gemini", "cerebras", "ollama-cloud"]));
  });

  it("names the provider from the key name or the service", () => {
    expect(modelProviderOfSecret("ANTHROPIC_API_KEY")).toBe("Anthropic");
    expect(modelProviderOfSecret("MY_LLM_KEY", "Anthropic")).toBe("Anthropic");
    expect(modelProviderOfSecret("CLAUDE_KEY")).toBe("Anthropic");
    expect(modelProviderOfSecret("OPENAI_API_KEY")).toBe("OpenAI");
    expect(modelProviderOfSecret("GEMINI_API_KEY")).toBe("Google Gemini");
    expect(modelProviderOfSecret("GOOGLE_GENERATIVE_AI_API_KEY")).toBe("Google Gemini");
    expect(modelProviderOfSecret("XAI_API_KEY")).toBe("xAI");
    expect(modelProviderOfSecret("GROQ_API_KEY")).toBe("Groq");
    expect(modelProviderOfSecret("OPENROUTER_API_KEY")).toBe("OpenRouter");
  });

  it("leaves ordinary credentials alone", () => {
    for (const [name, service] of [
      ["GITHUB_TOKEN", "GitHub"],
      ["STRIPE_SECRET_KEY", "Stripe"],
      ["GOOGLE_API_KEY", "Google Maps"],
      ["SUPABASE_FULL_ACCOUNT_TOKEN", undefined],
      ["TWILIO_AUTH_TOKEN", "Twilio"],
      ["RESEND_API_KEY", "Resend"],
    ] as const) {
      expect(modelProviderOfSecret(name, service), name).toBeNull();
    }
  });
});

describe("what the user and the agent are told", () => {
  it("the notice says the agent needs no such key and names the two reasons to save one", () => {
    const n = modelProviderKeyNotice("Anthropic");
    expect(n).toContain("never needs a key for Anthropic");
    expect(n).toContain("your own app or project");
    expect(n).toContain("run Local Agent X on Anthropic");
  });

  it("the guidance tells the agent the work is its own and how to fan it out", () => {
    const g = modelProviderKeyGuidance("OpenAI");
    expect(g).toContain("never need its key for your own work");
    expect(g).toContain("agent_spawn");
    expect(g).toContain("op_submit_batch");
  });
});
