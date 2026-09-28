// Replay of the 2026-09-27 incident through the real dispatcher and the real
// kernel (workspace-assistant preset, ariRequired): GET a project's secrets
// endpoint with a `find` filter, then POST a SQL migration the agent wrote to
// the same host.
//
// Before: the kernel's rule 6 quarantined the run on the SEQUENCE alone — a
// secrets-shaped URL was read, then something was posted — although the POST
// carried nothing from the GET. After: the GET's values are masked before the
// model sees them (the find filter runs on masked text), the authored POST is
// allowed and the run stays unrestricted, and a POST that embeds one of the
// fetched values is refused by the outbound scan, which knows the value because
// the masker registered it.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const undiciMock = vi.hoisted(() => ({
  handler: null as null | ((url: string, opts: unknown) => unknown),
  posts: [] as string[],
}));
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: (url: unknown, opts?: unknown) =>
      undiciMock.handler ? undiciMock.handler(String(url), opts) : actual.fetch(url as never, opts as never),
  };
});

const { executeToolCalls } = await import("./execute-tool.js");
const { createHttpRequestTool } = await import("../tools/http-request.js");
const { startAriKernel, stopAriKernel } = await import("../ari-kernel/lifecycle.js");
const { getFirewallForTest } = await import("../ari-kernel/state.js");
const { clearSessionTaint, checkEgressTaint } = await import("../data-lineage/index.js");
const { unregisterRedactedSecretValue } = await import("../security/secrets/index.js");
import type { ToolDefinition } from "../types.js";

function fakeResponse(status: number, body: string) {
  const h = new Map([["content-type", "application/json"]]);
  return {
    status,
    statusText: "OK",
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) => h.get(k.toLowerCase()) ?? null,
      forEach: (cb: (v: string, k: string) => void) => h.forEach((v, k) => cb(v, k)),
    },
    text: async () => body,
  };
}

const HOST = "https://api.supabase.com/v1/projects/abcdefghijkl";
const PASSWORD = "correct-horse-battery-staple-replay-42";
const SERVICE_KEY = "sbp_" + "Q7wE".repeat(8);
const SECRETS = JSON.stringify([
  { name: "DB_PASSWORD", value: PASSWORD },
  { name: "SERVICE_ROLE_KEY", value: SERVICE_KEY },
]);
const MIGRATION = "create table if not exists audit_log (id bigint generated always as identity primary key, at timestamptz default now());";

describe("replay: secrets GET (with find) → authored POST to the same host", () => {
  const sessionId = "replay-secrets-get-post";
  const operationId = "op-replay-secrets";
  const prevKey = process.env.LAX_AUDIT_KEY;
  let dir: string;
  const toolMap = new Map<string, ToolDefinition>([["http_request", createHttpRequestTool()]]);

  beforeAll(async () => {
    process.env.LAX_AUDIT_KEY = "test-replay-secrets-key-0123456789abcdef";
    dir = mkdtempSync(join(tmpdir(), "lax-replay-secrets-"));
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
    clearSessionTaint(sessionId);
    undiciMock.handler = (url, opts) => {
      const method = String((opts as { method?: string })?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        undiciMock.posts.push(String((opts as { body?: unknown })?.body ?? ""));
        return fakeResponse(200, '{"ok":true,"rows":[]}');
      }
      return fakeResponse(200, url.endsWith("/secrets") ? SECRETS : '{"functions":[]}');
    };
  });
  afterAll(() => {
    undiciMock.handler = null;
    stopAriKernel();
    unregisterRedactedSecretValue(PASSWORD);
    unregisterRedactedSecretValue(SERVICE_KEY);
    clearSessionTaint(sessionId);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
  });

  async function dispatch(id: string, args: Record<string, unknown>): Promise<string> {
    const msgs = await executeToolCalls(
      [{ id, name: "http_request", arguments: JSON.stringify(args) }],
      toolMap, undefined as never, undefined, undefined, undefined, undefined, sessionId,
      undefined, undefined, undefined, "run-replay", operationId, "local",
    );
    return String(msgs[msgs.length - 1]?.content ?? "");
  }

  it("the GET with a find filter shows the names and masked values, never a value", async () => {
    const out = await dispatch("1", { url: `${HOST}/secrets`, method: "GET", find: "DB_PASSWORD" });
    expect(out).toContain("DB_PASSWORD");
    expect(out).toContain('"value": "corr****"');
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(SERVICE_KEY);
    expect(out).toMatch(/secret values masked/);
    // The model never saw the bytes: the session is not tainted.
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  it("the authored migration POST is ALLOWED and the run is not quarantined", async () => {
    const out = await dispatch("2", { url: `${HOST}/database/query`, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: MIGRATION }) });
    expect(out).toContain('"ok": true');
    expect(out).not.toMatch(/blocked/i);
    expect(undiciMock.posts).toHaveLength(1);
    const fw = getFirewallForTest(operationId) as unknown as { isRestricted?: boolean; quarantineInfo?: unknown } | null;
    expect(fw?.isRestricted).toBe(false);
    expect(fw?.quarantineInfo ?? null).toBeNull();
  });

  it("a POST that embeds one of the fetched values is refused before it leaves, and the value is not echoed", async () => {
    const out = await dispatch("3", { url: `${HOST}/database/query`, method: "POST", body: JSON.stringify({ query: `insert into t values ('${PASSWORD}')` }) });
    expect(out).toMatch(/blocked/i);
    expect(out).toMatch(/secret-shaped content/);
    expect(out).not.toContain(PASSWORD);
    expect(undiciMock.posts).toHaveLength(1);
  });
});
