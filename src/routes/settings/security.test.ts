// POST /api/auth/rotate mints the operator token through rotateAuthToken, the
// one minting path: the new token is persisted AND registered for masking
// before the response is written. A route that minted its own token left the
// fresh credential unregistered, so any tool output that printed it (a `cat`
// of config.json, the startup URL file) showed it to the model in full.
//
// Drives the real config loader against the isolated data dir that
// test/setup/test-env.ts points HOME at.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, setRuntimeConfig, getConfigPath } from "../../config.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { maskSecretValues } from "../../data-lineage/index.js";
import { unregisterRedactedSecretValue } from "../../security/secrets/index.js";
import type { ServerContext } from "../../server-context.js";
import { handleSecurityRoutes } from "./security.js";

function capture(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0;
  let body = "";
  const res = {
    writeHead(s: number) { status = s; return this; },
    end(chunk?: string) { body += chunk ?? ""; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

describe("POST /api/auth/rotate", () => {
  const minted: string[] = [];
  let oldToken: string;

  beforeAll(() => {
    const config = loadConfig();
    setRuntimeConfig(config);
    oldToken = config.authToken;
  });
  afterAll(() => { for (const t of [oldToken, ...minted]) unregisterRedactedSecretValue(t); });

  it("the new token is masked in any output from the moment the route returns it", async () => {
    const rekeyed: string[] = [];
    const config = { ...loadConfig() };
    const ctx = {
      dataDir: getLaxDir(),
      config,
      rbac: { rotateOperatorToken: (t: string) => { rekeyed.push(t); } },
    } as unknown as ServerContext;
    const out = capture();
    const req = { headers: {} } as IncomingMessage;

    expect(await handleSecurityRoutes("POST", new URL("http://test/api/auth/rotate"), req, out.res, ctx, "operator")).toBe(true);
    expect(out.status()).toBe(200);
    const token = JSON.parse(out.body()).token as string;
    minted.push(token);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(oldToken);
    // Registered: a registered-values-only pass (what a file read gets) masks it.
    const shown = maskSecretValues(`http://127.0.0.1:7007/?token=${token}`, { knownOnly: true });
    expect(shown.masked).toBe(1);
    expect(shown.text).not.toContain(token);
    // Persisted, and every live holder was re-keyed to the same value.
    expect(JSON.parse(readFileSync(getConfigPath(), "utf-8")).authToken).toBe(token);
    expect(config.authToken).toBe(token);
    expect(rekeyed).toEqual([token]);
  });

  it("a non-operator role cannot rotate", async () => {
    const out = capture();
    const ctx = { config: loadConfig() } as unknown as ServerContext;
    await handleSecurityRoutes("POST", new URL("http://test/api/auth/rotate"), { headers: {} } as IncomingMessage, out.res, ctx, "agent");
    expect(out.status()).toBe(403);
  });
});
