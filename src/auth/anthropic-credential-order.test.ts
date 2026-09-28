/**
 * A subscription sign-in wins over an ANTHROPIC_API_KEY in the environment.
 *
 * The instance (2026-09-27): `setx ANTHROPIC_API_KEY` for another project put
 * a pay-as-you-go key in the user's environment. Chats kept running on the
 * subscription — the chat transport takes the OAuth token first — but the
 * credential the op was BOOKED under came from getAnthropicApiKey, which
 * checked the environment key first. Every turn was counted as API spend, and
 * the $15 session budget stopped a session that had cost nothing. Pinned here:
 * with a sign-in present the resolver returns it, and the credential source the
 * ledger and the spend cap read is "oauth"; the key is used only without one.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

beforeEach(() => {
  storage.__set(null);
  rmSync(CLI_FILE, { force: true });
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = API_KEY;
});
afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe("the credential an Anthropic op is booked under", () => {
  it("is the saved sign-in, not the environment key", async () => {
    storage.__set({ accessToken: "setup-token", method: "token", provider: "anthropic" });
    expect(await getAnthropicApiKey()).toBe("oauth:setup-token");
    const r = await AUTH_PROVIDERS.anthropic.resolve({}, null);
    expect(r?.source).toBe("oauth");
  });

  it("is a live refreshable sign-in, not the environment key", async () => {
    storage.__set({ accessToken: "live", refreshToken: "r", expiresAt: Date.now() + 60 * 60_000, method: "oauth", provider: "anthropic" });
    expect(await getAnthropicApiKey()).toBe("oauth:live");
    expect((await AUTH_PROVIDERS.anthropic.resolve({}, null))?.source).toBe("oauth");
  });

  it("is the Claude CLI's unexpired grant, not the environment key", async () => {
    writeFileSync(CLI_FILE, JSON.stringify({ claudeAiOauth: { accessToken: "cli-grant", expiresAt: Date.now() + 60 * 60_000 } }));
    expect(await getAnthropicApiKey()).toBe("oauth:cli-grant");
    expect((await AUTH_PROVIDERS.anthropic.resolve({}, null))?.source).toBe("oauth");
  });

  it("is the environment key only when nothing is signed in, and is then booked as API spend", async () => {
    expect(await getAnthropicApiKey()).toBe(API_KEY);
    const r = await AUTH_PROVIDERS.anthropic.resolve({}, null);
    expect(r?.source).toBe("env");
    expect(r?.credential).toBe(API_KEY);
  });
});
