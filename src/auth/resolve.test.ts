// A service key (web search, speech to text) is read from Settings → Secrets
// first and the environment second: a key the user saved is never ignored.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSecretsStoreSingleton, type SecretsStore } from "../secrets.js";
import { resolveServiceKey } from "./resolve.js";

const NAME = "LAX_TEST_SERVICE_KEY";

function saved(values: Record<string, string>): void {
  setSecretsStoreSingleton({ get: (n: string) => values[n] } as unknown as SecretsStore);
}

beforeEach(() => { delete process.env[NAME]; });
afterEach(() => {
  delete process.env[NAME];
  setSecretsStoreSingleton(null as unknown as SecretsStore);
});

describe("resolveServiceKey", () => {
  it("reads a key saved in Settings → Secrets", () => {
    saved({ [NAME]: "from-settings" });
    expect(resolveServiceKey(NAME)).toBe("from-settings");
  });

  it("prefers the saved key over the environment", () => {
    saved({ [NAME]: "from-settings" });
    process.env[NAME] = "from-env";
    expect(resolveServiceKey(NAME)).toBe("from-settings");
  });

  it("falls back to the environment when nothing is saved", () => {
    saved({});
    process.env[NAME] = " from-env ";
    expect(resolveServiceKey(NAME)).toBe("from-env");
  });

  it("works before the secrets store exists, and is undefined with no key anywhere", () => {
    setSecretsStoreSingleton(null as unknown as SecretsStore);
    expect(resolveServiceKey(NAME)).toBeUndefined();
    process.env[NAME] = "from-env";
    expect(resolveServiceKey(NAME)).toBe("from-env");
  });
});
