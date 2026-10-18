// Signing in with ChatGPT allows the Codex backend's host for web access, as
// connecting a built-in integration allows its API host: under strict web
// access the subscription's image calls were otherwise blocked at the first
// call for a run with nobody to click "Allow & retry". A failed sign-in
// allows nothing.
import { describe, expect, it, vi } from "vitest";
import { handleCoreAuthRoutes } from "./core-openai.js";

// Made when the route asks for it, so a failing sign-in's rejection is never
// left unhandled before the route attaches its handlers.
let outcome: () => Promise<unknown> = () => Promise.resolve({});
let loginOutcome: Promise<unknown> = Promise.resolve({});
vi.mock("../../../auth/index.js", () => ({
  initiateOAuthLogin: () => ({ authUrl: "https://auth.openai.com/oauth/authorize?x=1", promise: (loginOutcome = outcome()) }),
}));

type Handler = typeof handleCoreAuthRoutes;

async function login() {
  const egress = { allow: vi.fn(), snapshot: vi.fn(() => ({ mode: "strict", allowlist: ["chatgpt.com"], configured: true })) };
  const broadcastAll = vi.fn();
  const res = { statusCode: 0, body: "", writeHead(s: number) { res.statusCode = s; return res; }, end(b?: string) { if (b) res.body = b; return res; } };
  await handleCoreAuthRoutes(
    "POST",
    new URL("http://127.0.0.1/api/auth/login"),
    { headers: {} } as unknown as Parameters<Handler>[2],
    res as unknown as Parameters<Handler>[3],
    { security: { egress }, broadcastAll } as unknown as Parameters<Handler>[4],
    "operator",
  );
  await loginOutcome.catch(() => {});
  await new Promise((r) => setImmediate(r));
  return { res, egress, broadcastAll };
}

describe("POST /api/auth/login (ChatGPT sign-in)", () => {
  it("allows chatgpt.com once the sign-in completes, and tells open tabs", async () => {
    outcome = () => Promise.resolve({});
    const { res, egress, broadcastAll } = await login();
    expect(res.statusCode).toBe(200);
    expect(egress.allow).toHaveBeenCalledWith("chatgpt.com");
    expect(broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { egress: expect.objectContaining({ mode: "strict" }) } });
  });

  it("allows nothing when the sign-in fails", async () => {
    outcome = () => Promise.reject(new Error("denied"));
    const { egress, broadcastAll } = await login();
    expect(egress.allow).not.toHaveBeenCalled();
    expect(broadcastAll).not.toHaveBeenCalled();
  });
});
