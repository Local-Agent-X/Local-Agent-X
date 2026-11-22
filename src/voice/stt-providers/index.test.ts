// A cloud STT provider gets the key saved in Settings → Secrets on every voice
// path. The bridge path passed no key and so read only the environment.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setSecretsStoreSingleton, type SecretsStore } from "../../secrets.js";

const seen: Array<{ provider: string; cfg: unknown }> = [];
const fake = (provider: string) => (cfg: unknown) => { seen.push({ provider, cfg }); return {} as never; };
vi.mock("./groq.js", () => ({ createGroqTranscriber: fake("groq") }));
vi.mock("./openai.js", () => ({ createOpenAITranscriber: fake("openai") }));
vi.mock("./mistral.js", () => ({ createMistralTranscriber: fake("mistral") }));

const { createSttProvider } = await import("./index.js");

function saved(values: Record<string, string>): void {
  setSecretsStoreSingleton({ get: (n: string) => values[n] } as unknown as SecretsStore);
}

afterEach(() => {
  seen.length = 0;
  setSecretsStoreSingleton(null as unknown as SecretsStore);
});

describe("createSttProvider — saved keys", () => {
  it("fills each cloud provider's key from Settings → Secrets", () => {
    saved({ GROQ_API_KEY: "g", OPENAI_API_KEY: "o", MISTRAL_API_KEY: "m" });
    createSttProvider("groq", { cloud: {} });
    createSttProvider("openai");
    createSttProvider("mistral", { cloud: { model: "voxtral" } });
    expect(seen).toEqual([
      { provider: "groq", cfg: { apiKey: "g" } },
      { provider: "openai", cfg: { apiKey: "o" } },
      { provider: "mistral", cfg: { model: "voxtral", apiKey: "m" } },
    ]);
  });

  it("keeps a key the caller passed", () => {
    saved({ GROQ_API_KEY: "saved" });
    createSttProvider("groq", { cloud: { apiKey: "caller" } });
    expect(seen[0].cfg).toEqual({ apiKey: "caller" });
  });

  it("with nothing saved, leaves the provider to read its environment", () => {
    saved({});
    createSttProvider("openai", { cloud: { language: "en" } });
    expect(seen[0].cfg).toEqual({ language: "en" });
  });
});
