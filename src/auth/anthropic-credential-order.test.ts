/**
 * The "anthropic" provider is the picker's "Anthropic Claude (subscription
 * auth)": it runs on a Claude subscription sign-in and nothing else.
 *
 * The instance (2026-09-27): `setx ANTHROPIC_API_KEY` for another project put
 * a pay-as-you-go key in the user's environment. Chats kept running on the
 * subscription — the chat transport takes the OAuth token first — but the
 * credential the op was BOOKED under came from getAnthropicApiKey, which
 * returned the environment key. Every turn was counted as API spend, and the
 * $15 session budget stopped a session that had cost nothing. Pinned here: the
 * resolver returns the sign-in, the source the ledger and spend cap read is
 * "oauth", and an API key — environment or secrets store — is never used.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SecretsStore } from "../secrets.js";

const DATA = mkdtempSync(join(tmpdir(), "lax-anthropic-order-"));
process.env.LAX_DATA_DIR = DATA;

const HOME = mkdtempSync(join(tmpdir(), "lax-home-"));
mkdirSync(join(HOME, ".claude"), { recursive: true });
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => HOME }));

vi.mock("./storage.js", () => {
  let stored: unknown = null;
  return {
    readProviderCredentials: () => stored,
    writeProviderCredentials: (_p: string, v: unknown) => { stored = v; },
    __set: (v: unknown) => { stored = v; },
  };
});

const storage = await import("./storage.js") as unknown as { __set: (v: unknown) => void };
const { getAnthropicApiKey } = await import("./anthropic.js");
const { AUTH_PROVIDERS } = await import("./auth-provider.js");

const API_KEY = "sk-ant-api03-exported-for-another-project";
const CLI_FILE = join(HOME, ".claude", ".credentials.json");
const storeWithKey = { get: (k: string) => (k === "ANTHROPIC_API_KEY" ? "sk-ant-api03-saved-in-settings" : undefined) } as unknown as SecretsStore;

beforeEach(() => {
  storage.__set(null);
  rmSync(CLI_FILE, { force: true });
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = API_KEY;
});
afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe("the Anthropic subscription provider", () => {
  it("runs on the saved sign-in and is booked as the subscription, with a key in the environment", async () => {
    storage.__set({ accessToken: "setup-token", method: "token", provider: "anthropic" });
    expect(await getAnthropicApiKey()).toBe("oauth:setup-token");
    expect(await AUTH_PROVIDERS.anthropic.resolve({}, storeWithKey)).toEqual({
      provider: "anthropic", credential: "oauth:setup-token", source: "oauth",
    });
  });

  it("runs on a live refreshable sign-in", async () => {
    storage.__set({ accessToken: "live", refreshToken: "r", expiresAt: Date.now() + 60 * 60_000, method: "oauth", provider: "anthropic" });
    expect((await AUTH_PROVIDERS.anthropic.resolve({}, storeWithKey))?.credential).toBe("oauth:live");
  });

  it("runs on the Claude CLI's unexpired grant", async () => {
    writeFileSync(CLI_FILE, JSON.stringify({ claudeAiOauth: { accessToken: "cli-grant", expiresAt: Date.now() + 60 * 60_000 } }));
    expect((await AUTH_PROVIDERS.anthropic.resolve({}, storeWithKey))?.credential).toBe("oauth:cli-grant");
  });

  it("never falls back to an API key, from the environment or the secrets store", async () => {
    await expect(getAnthropicApiKey()).rejects.toThrow(/Not signed in to a Claude subscription/);
    expect(await AUTH_PROVIDERS.anthropic.resolve({}, storeWithKey)).toBeNull();
  });

  it("gives a caller that must not use the subscription nothing at all", async () => {
    storage.__set({ accessToken: "setup-token", method: "token", provider: "anthropic" });
    expect(await AUTH_PROVIDERS.anthropic.resolve({ rejectOAuth: true }, storeWithKey)).toBeNull();
  });
});
