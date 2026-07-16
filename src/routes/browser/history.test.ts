/**
 * History routes — handler ownership (exact method+path claims), query
 * passthrough, and the delete/clear split. Store state is real (isolated
 * per-file ~/.lax via test-env setup).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../../server-context.js";
import type { Role } from "../../rbac.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { BrowserHistoryStore, type HistoryEntry } from "../../browser/history-store.js";
import { handleBrowserHistoryRoutes } from "./history.js";

function mkRes() {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => { status = s; },
    end: (b: string) => { body = b; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => JSON.parse(body) as unknown };
}

const req = { headers: {} } as IncomingMessage;
const ctx = {} as ServerContext;
const role = "owner" as Role;
const u = (path: string) => new URL(`http://localhost${path}`);

beforeEach(() => {
  rmSync(join(getLaxDir(), "browser-history.json"), { force: true });
  BrowserHistoryStore._resetForTest();
});

describe("handleBrowserHistoryRoutes", () => {
  it("GET /api/browser/history → 200 newest-first, honoring q/profile/limit", async () => {
    const store = BrowserHistoryStore.getInstance();
    store.recordVisit("default", "https://example.com/a", "Alpha");
    store.recordVisit("work", "https://example.com/b", "Beta");

    let r = mkRes();
    expect(await handleBrowserHistoryRoutes("GET", u("/api/browser/history"), req, r.res, ctx, role)).toBe(true);
    expect(r.status()).toBe(200);
    expect((r.body() as HistoryEntry[]).map((e) => e.title)).toEqual(["Beta", "Alpha"]);

    r = mkRes();
    await handleBrowserHistoryRoutes("GET", u("/api/browser/history?profile=work"), req, r.res, ctx, role);
    expect((r.body() as HistoryEntry[]).map((e) => e.title)).toEqual(["Beta"]);

    r = mkRes();
    await handleBrowserHistoryRoutes("GET", u("/api/browser/history?q=alpha&limit=1"), req, r.res, ctx, role);
    expect((r.body() as HistoryEntry[]).map((e) => e.title)).toEqual(["Alpha"]);
  });

  it("DELETE /api/browser/history/:id removes one entry (404 for unknown)", async () => {
    const e = BrowserHistoryStore.getInstance().recordVisit("default", "https://example.com/x", "")!;
    let r = mkRes();
    expect(await handleBrowserHistoryRoutes("DELETE", u(`/api/browser/history/${e.id}`), req, r.res, ctx, role)).toBe(true);
    expect(r.status()).toBe(200);
    expect(BrowserHistoryStore.getInstance().query()).toHaveLength(0);

    r = mkRes();
    await handleBrowserHistoryRoutes("DELETE", u("/api/browser/history/hist-nope"), req, r.res, ctx, role);
    expect(r.status()).toBe(404);
  });

  it("DELETE /api/browser/history clears everything and reports the count", async () => {
    const store = BrowserHistoryStore.getInstance();
    store.recordVisit("default", "https://example.com/1", "");
    store.recordVisit("work", "https://example.com/2", "");
    const r = mkRes();
    expect(await handleBrowserHistoryRoutes("DELETE", u("/api/browser/history"), req, r.res, ctx, role)).toBe(true);
    expect(r.body()).toEqual({ ok: true, cleared: 2 });
    expect(store.query()).toHaveLength(0);
  });

  it("does not claim other paths or methods", async () => {
    const r = mkRes();
    expect(await handleBrowserHistoryRoutes("POST", u("/api/browser/history"), req, r.res, ctx, role)).toBe(false);
    expect(await handleBrowserHistoryRoutes("GET", u("/api/browser/historyx"), req, r.res, ctx, role)).toBe(false);
    expect(await handleBrowserHistoryRoutes("GET", u("/api/browser/bookmarks"), req, r.res, ctx, role)).toBe(false);
  });
});
