import { describe, expect, it, beforeEach, vi } from "vitest";

import { selfCallAuthHeader } from "./web-tools.js";
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
