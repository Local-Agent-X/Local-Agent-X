import { afterEach, describe, expect, it } from "vitest";
import type { SecretsStore } from "../secrets.js";
import { AUTH_PROVIDERS } from "./auth-provider.js";

const previousOpenAI = process.env.OPENAI_API_KEY;
const store = { get: (name: string) => name === "OPENAI_API_KEY" ? "store-secret" : null } as SecretsStore;

afterEach(() => {
  if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAI;
});

describe("credential source pinning", () => {
  it.each([
    ["config", "config-secret"],
    ["secrets-store", "store-secret"],
    ["env", "env-secret"],
  ] as const)("resolves only the required %s source", async (requiredSource, expected) => {
    process.env.OPENAI_API_KEY = "env-secret";
    const result = await AUTH_PROVIDERS.openai.resolve({ requiredSource, configOpenAIKey: "config-secret" }, store);
    expect(result).toEqual({ provider: "openai", credential: expected, source: requiredSource });
  });

  it("does not switch sources when the pinned source is unavailable", async () => {
    process.env.OPENAI_API_KEY = "env-secret";
    const result = await AUTH_PROVIDERS.openai.resolve({ requiredSource: "secrets-store", configOpenAIKey: "config-secret" }, null);
    expect(result).toBeNull();
  });
});
