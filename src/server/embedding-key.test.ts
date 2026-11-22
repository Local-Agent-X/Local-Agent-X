// Memory embeddings use the key chat uses for the same provider: the provider's
// own key order (auth-provider.ts), not a second order of their own. They used
// to put the saved key ahead of the config key, which chat checks first.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretsStore } from "../secrets.js";
import type { LAXConfig } from "../types.js";
import type { MemoryIndex } from "../memory/index.js";

const state = { embeddingProvider: "openai" };
const created: Array<{ provider: string; apiKey?: string }> = [];

vi.mock("../settings.js", async (orig) => ({
  ...(await orig<typeof import("../settings.js")>()),
  loadSettings: () => ({ embeddingProvider: state.embeddingProvider }),
}));
vi.mock("../embedding-providers/index.js", async (orig) => ({
  ...(await orig<typeof import("../embedding-providers/index.js")>()),
  createEmbeddingProvider: (opts: { provider: string; apiKey?: string }) => {
    created.push({ provider: opts.provider, apiKey: opts.apiKey });
    return { name: "local", model: "m", dimensions: 1, embed: async () => [0], embedQuery: async () => [0] };
  },
}));

const { initOrRefreshEmbeddingProvider } = await import("./bootstrap-services.js");

function init(configKey: string | undefined, saved: Record<string, string>) {
  return initOrRefreshEmbeddingProvider({
    config: { openaiApiKey: configKey } as LAXConfig,
    dataDir: "",
    secretsStore: { get: (n: string) => saved[n] } as unknown as SecretsStore,
    memoryIndex: { setEmbeddingProvider: async () => {} } as unknown as MemoryIndex,
  });
}

afterEach(() => {
  created.length = 0;
  delete process.env.GEMINI_API_KEY;
});

describe("embedding provider key", () => {
  it("OpenAI: the config key first, as chat reads it", async () => {
    state.embeddingProvider = "openai";
    await init("from-config", { OPENAI_API_KEY: "from-settings" });
    expect(created).toEqual([{ provider: "openai", apiKey: "from-config" }]);
  });

  it("OpenAI: the saved key when there is no config key", async () => {
    state.embeddingProvider = "openai";
    await init(undefined, { OPENAI_API_KEY: "from-settings" });
    expect(created[0].apiKey).toBe("from-settings");
  });

  it("Gemini: the environment when nothing is saved", async () => {
    state.embeddingProvider = "gemini";
    process.env.GEMINI_API_KEY = "from-env";
    await init(undefined, {});
    expect(created[0].apiKey).toBe("from-env");
  });
});
