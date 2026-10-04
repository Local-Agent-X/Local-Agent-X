// Saving a website login in the secret card approves filling it there. Twilio
// signs in at login.twilio.com for a login saved on www.twilio.com; the page
// the agent's browser is on right now is where the login is about to go, so
// a same-site page is approved with it and the user is not asked again for a
// login they just saved. Another site is never approved this way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { handleSecretsRoutes } from "./secrets.js";
import { _clearSiteProvenance, recordSiteTokens } from "../../browser/site-provenance.js";

async function approve(body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  const res = { statusCode: 0, body: "", setHeader() {}, writeHead(s: number) { res.statusCode = s; return res; }, end(c?: string) { if (c) res.body = c; return res; } };
  const secretsStore = { approveFill: vi.fn(() => true) };
  const broadcastAll = vi.fn();
  await handleSecretsRoutes("POST", new URL("http://127.0.0.1/api/secrets/TWILIO_PASSWORD/approve-origin"),
    req as never, res as never, { secretsStore, broadcastAll } as never, "operator");
  return { res, approved: secretsStore.approveFill.mock.calls.map((c: unknown[]) => c[1]), broadcastAll };
}

afterEach(() => _clearSiteProvenance());

describe("approve-origin from the secret card", () => {
  it("approves the card's site and the agent's current page when it is the same site", async () => {
    recordSiteTokens("chat-1", "https://login.twilio.com/u/login?state=abc", "Sign in");
    const { approved, broadcastAll } = await approve({ origin: "https://www.twilio.com/", sessionId: "chat-1" });
    expect(approved).toEqual(["https://www.twilio.com", "https://login.twilio.com"]);
    expect(broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { secrets: true } });
  });

  it("never approves the agent's current page on another site", async () => {
    recordSiteTokens("chat-1", "https://twilio-login.attacker.test/", "Sign in");
    const { approved } = await approve({ origin: "https://www.twilio.com/", sessionId: "chat-1" });
    expect(approved).toEqual(["https://www.twilio.com"]);
  });

  it("approves only the given origin when no chat is named (Settings)", async () => {
    recordSiteTokens("chat-1", "https://login.twilio.com/u/login", "Sign in");
    const { approved } = await approve({ origin: "https://www.twilio.com/" });
    expect(approved).toEqual(["https://www.twilio.com"]);
  });
});
