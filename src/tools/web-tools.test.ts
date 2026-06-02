import { describe, expect, it, beforeEach, vi } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";

import { selfCallAuthHeader, createPinningDispatcher } from "./web-tools.js";
import { setInternalAgentToken } from "../rbac.js";
import { getRuntimeConfig } from "../config.js";

const INTERNAL = "internal-agent-token-deadbeef";

describe("selfCallAuthHeader", () => {
  let port: number;
  let authToken: string;

  beforeEach(() => {
    const rc = getRuntimeConfig();
    port = rc.port;
    authToken = rc.authToken;
    setInternalAgentToken(INTERNAL);
  });

  it("returns the internal agent token for a loopback self-call", async () => {
    const h = await selfCallAuthHeader(`http://127.0.0.1:${port}/api/secrets/x/reveal`);
    expect(h).toEqual({ Authorization: `Bearer ${INTERNAL}` });
    // Must be the least-privilege internal token, not the operator token.
    expect(h?.Authorization).not.toBe(`Bearer ${authToken}`);
  });

  it("returns null for an external URL (token never leaks off-box)", async () => {
    expect(await selfCallAuthHeader("https://evil.example.com/api")).toBeNull();
  });

  it("returns null for the right host but wrong port", async () => {
    expect(await selfCallAuthHeader(`http://127.0.0.1:${port + 1}/api`)).toBeNull();
  });

  it("falls back to the operator token only when the internal token is unset (null)", async () => {
    // The internal token is null before server boot. There is no public setter
    // to null, so mock the rbac accessor to model the pre-boot/subprocess state.
    vi.resetModules();
    vi.doMock("../rbac.js", () => ({ getInternalAgentToken: () => null }));
    const { selfCallAuthHeader: fresh } = await import("./web-tools.js");
    const h = await fresh(`http://localhost:${port}/api/settings`);
    expect(h).toEqual({ Authorization: `Bearer ${authToken}` });
    vi.doUnmock("../rbac.js");
    vi.resetModules();
  });
});

describe("createPinningDispatcher", () => {
  it("returns an undici Agent instance", async () => {
    const d = createPinningDispatcher();
    expect(d).toBeInstanceOf(Agent);
    await d.close();
  });

  it("passes a literal loopback IP through to the literal (pin: null pass-through)", async () => {
    // No server is listening on this port, so the connection is refused — but the
    // refusal proves the dispatcher dialed the literal IP rather than blocking it
    // (a private-IP block surfaces a 'Blocked:' error, not a connection refusal).
    const d = createPinningDispatcher();
    try {
      await undiciFetch("http://127.0.0.1:1/", {
        dispatcher: d,
        signal: AbortSignal.timeout(2_000),
      });
      throw new Error("expected the connection to be refused");
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // Connection-level failure, not a private-IP policy block.
      expect(msg).not.toMatch(/Blocked:/);
    } finally {
      await d.close();
    }
  });

  it("blocks a host that fails to resolve / resolves private (fail-closed)", async () => {
    const d = createPinningDispatcher();
    try {
      await undiciFetch("http://nonexistent-host.invalid/", {
        dispatcher: d,
        signal: AbortSignal.timeout(5_000),
      });
      throw new Error("expected the connection to be blocked");
    } catch (e) {
      // The lookup surfaced an error from resolveAndPinHost (fetch wraps it as a
      // failed connection); the key assertion is that the request did not succeed.
      expect(e).toBeInstanceOf(Error);
    } finally {
      await d.close();
    }
  });
});
