// frontendEnv contract: a frontend dev server's child env must carry the three
// vars the harness-owned vite.config reads — LAX_DEV_PORT (HMR), and
// LAX_SERVER_PORT + LAX_CONNECTOR_TOKEN (the /api/connectors dev proxy that
// makes direct-origin pages reach LAX). A backend gets none of them, and the
// connector value must be the scoped capability, never the operator token.

import { describe, it, expect } from "vitest";
import { frontendEnv } from "./dev-server-command.js";
import { getRuntimeConfig } from "../config.js";

describe("frontendEnv", () => {
  it("frontend: sets HMR + connector-proxy env for the vite config to read", () => {
    const env = frontendEnv("frontend", 5173) ?? {};
    expect(env.LAX_DEV_PORT).toBe("5173");
    expect(Number(env.LAX_SERVER_PORT)).toBeGreaterThan(0);
    // The capability is an HMAC of the operator token — 64 hex chars, and never
    // the operator token itself.
    if (env.LAX_CONNECTOR_TOKEN) {
      expect(env.LAX_CONNECTOR_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      const cfg = getRuntimeConfig();
      if (cfg.authToken) expect(env.LAX_CONNECTOR_TOKEN).not.toBe(cfg.authToken);
    }
  });

  it("backend: no frontend env vars leak in", () => {
    const env = frontendEnv("backend", 3001) ?? {};
    expect(env.LAX_DEV_PORT).toBeUndefined();
    expect(env.LAX_SERVER_PORT).toBeUndefined();
    expect(env.LAX_CONNECTOR_TOKEN).toBeUndefined();
  });
});
