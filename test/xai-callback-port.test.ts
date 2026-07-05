// Regression: the xAI OAuth callback hardcoded port 56121 with no fallback. On
// Windows that port can land in a reserved/excluded range (Hyper-V/WSL/Docker)
// → listen() throws EACCES → the whole /login route crashed ("Failed to fetch",
// browser never opens). listenOnFreePort must fall back to a free port. EADDRINUSE
// exercises the same fallback branch as the EACCES this targets.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { listenOnFreePort } from "../src/auth/xai-login";
import { isTerminalRefreshError } from "../src/auth/xai";

const open: Server[] = [];
const mk = (): Server => { const s = createServer(); open.push(s); return s; };
const portOf = (s: Server): number => (s.address() as { port: number }).port;

afterEach(() => { for (const s of open) { try { s.close(); } catch { /* already closed */ } } open.length = 0; });

describe("listenOnFreePort (xAI OAuth callback)", () => {
  it("falls back to a different free port when the preferred port is taken", async () => {
    const blocker = mk();
    const taken = await new Promise<number>((r) => blocker.listen(0, "127.0.0.1", () => r(portOf(blocker))));

    const bound = await listenOnFreePort(mk(), taken, "127.0.0.1");
    expect(bound).toBeGreaterThan(0);
    expect(bound).not.toBe(taken); // did not crash on EADDRINUSE — fell back
  });

  it("binds the preferred port when it is available", async () => {
    // port 0 = OS picks a guaranteed-free port; no fallback branch needed.
    const bound = await listenOnFreePort(mk(), 0, "127.0.0.1");
    expect(bound).toBeGreaterThan(0);
  });
});

describe("isTerminalRefreshError (clear a dead token, keep through transient fails)", () => {
  it("treats revoked/expired refresh tokens as terminal", () => {
    expect(isTerminalRefreshError('xAI token refresh failed (400): {"error":"invalid_grant"}')).toBe(true);
    expect(isTerminalRefreshError("Refresh token has been revoked")).toBe(true);
    expect(isTerminalRefreshError("token has expired")).toBe(true);
    expect(isTerminalRefreshError("unauthorized_client")).toBe(true);
  });

  it("treats network/timeout/5xx as transient (keep the token, retry)", () => {
    expect(isTerminalRefreshError("The operation was aborted due to timeout")).toBe(false);
    expect(isTerminalRefreshError("fetch failed")).toBe(false);
    expect(isTerminalRefreshError("ECONNRESET")).toBe(false);
    expect(isTerminalRefreshError("xAI token refresh failed (503): Service Unavailable")).toBe(false);
  });
});
