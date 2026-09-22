/**
 * A subscription token the API rejected is never sent again.
 *
 * The instance (a user's chat, 2026-09-21): a working turn at 3:57, then
 * 401 "Invalid bearer token" at 3:58 and on every turn after. Refresh ran
 * only when the STORED expiry had passed, so a token that died early was
 * re-sent unchanged until the user signed in again — and the raw JSON is what
 * they read. Pinned here: the resolver, told which token was rejected,
 * returns a different one or nothing; a Claude CLI file token is distrusted
 * for the process once rejected; and the message a user reads names the
 * control the UI actually has.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "lax-anthropic-401-"));
process.env.LAX_DATA_DIR = DATA;
delete process.env.ANTHROPIC_OAUTH_TOKEN;

// The Claude CLI credentials file, redirected into the temp dir.
const HOME = mkdtempSync(join(tmpdir(), "lax-home-"));
mkdirSync(join(HOME, ".claude"), { recursive: true });
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => HOME }));

const refreshCalls: string[] = [];
vi.mock("./storage.js", () => {
  let stored: unknown = null;
  return {
    readProviderCredentials: () => stored,
    writeProviderCredentials: (_p: string, v: unknown) => { stored = v; },
    __set: (v: unknown) => { stored = v; },
  };
});

const storage = await import("./storage.js") as unknown as { __set: (v: unknown) => void };
const auth = await import("./anthropic.js");

function cliFile(accessToken: string, expiresInMs = 60 * 60_000) {
  writeFileSync(join(HOME, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken, expiresAt: Date.now() + expiresInMs } }));
}

beforeEach(() => { storage.__set(null); refreshCalls.length = 0; });

describe("the resolver never hands back the token that was just rejected", () => {
  it("an owned oauth lineage is refreshed even though its stored expiry has not passed", async () => {
    storage.__set({ accessToken: "old-access", refreshToken: "r1", expiresAt: Date.now() + 60 * 60_000, method: "oauth", provider: "anthropic" });
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      refreshCalls.push("refresh");
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "r2", expires_in: 3600 }), { status: 200 });
    });
    // Sanity: without a rejection the unexpired token is used as-is.
    expect(await auth.getAnthropicDirectToken()).toBe("old-access");
    expect(refreshCalls).toHaveLength(0);
    // Told it was rejected: refresh, and return the new one.
    expect(await auth.getAnthropicDirectToken({ rejected: "old-access" })).toBe("new-access");
    expect(refreshCalls).toEqual(["refresh"]);
    vi.restoreAllMocks();
  });

  it("a long-lived setup token cannot be refreshed, so a rejection yields nothing rather than the same token", async () => {
    storage.__set({ accessToken: "setup-tok", method: "token", provider: "anthropic" });
    expect(await auth.getAnthropicDirectToken()).toBe("setup-tok");
    expect(await auth.getAnthropicDirectToken({ rejected: "setup-tok" })).toBeNull();
  });

  it("a Claude CLI file token is distrusted for the process once the API rejected it", async () => {
    cliFile("cli-file-tok");
    expect(await auth.getAnthropicDirectToken()).toBe("cli-file-tok");
    expect(await auth.getAnthropicDirectToken({ rejected: "cli-file-tok" })).toBeNull();
    // The file still says it is valid for an hour. Its word is no longer good.
    expect(await auth.getAnthropicDirectToken()).toBeNull();
    // A NEW token in the file — the user signed in again — is trusted.
    cliFile("cli-file-tok-2");
    expect(await auth.getAnthropicDirectToken()).toBe("cli-file-tok-2");
  });
});

describe("what the user reads", () => {
  it("names the control exactly as the settings page labels it", async () => {
    const { SIGN_IN_AGAIN_MESSAGE } = await import("../anthropic-client/stream-api.js");
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(join(process.cwd(), "public", "app.html"), "utf8");
    expect(html).toContain("Anthropic Authentication");
    expect(html).toContain("Sign in with Claude subscription");
    expect(SIGN_IN_AGAIN_MESSAGE).toContain("Anthropic Authentication");
    expect(SIGN_IN_AGAIN_MESSAGE).toContain("Sign in with Claude subscription");
    expect(SIGN_IN_AGAIN_MESSAGE, "must not leak the raw wire error").not.toMatch(/invalid_request|authentication_error|request_id/);
  });
});
