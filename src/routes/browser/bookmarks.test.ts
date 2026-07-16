/**
 * Bookmark routes — handler ownership, POST validation (url required, tags
 * shape), addedBy:"user" stamping, and delete. Store state is real (isolated
 * per-file ~/.lax via test-env setup).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../../server-context.js";
import type { Role } from "../../rbac.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { BrowserBookmarkStore, type BrowserBookmark } from "../../browser/bookmark-store.js";
import { handleBrowserBookmarkRoutes } from "./bookmarks.js";

function mkRes() {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => { status = s; },
    end: (b: string) => { body = b; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => JSON.parse(body) as unknown };
}

function mkReq(body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  (stream as unknown as { headers: Record<string, string> }).headers = {};
  return stream as unknown as IncomingMessage;
}

const ctx = {} as ServerContext;
const role = "owner" as Role;
const u = (path: string) => new URL(`http://localhost${path}`);

beforeEach(() => {
  rmSync(join(getLaxDir(), "browser-bookmarks.json"), { force: true });
  BrowserBookmarkStore._resetForTest();
});

describe("handleBrowserBookmarkRoutes", () => {
  it("POST /api/browser/bookmarks creates a USER bookmark from the body", async () => {
    const r = mkRes();
    const handled = await handleBrowserBookmarkRoutes(
      "POST", u("/api/browser/bookmarks"),
      mkReq({ url: "https://example.com/docs", title: "Docs", tags: ["ref"], profileId: "work" }),
      r.res, ctx, role,
    );
    expect(handled).toBe(true);
    expect(r.status()).toBe(200);
    const bm = r.body() as BrowserBookmark;
    expect(bm.addedBy).toBe("user");
    expect(bm.title).toBe("Docs");
    expect(bm.profileId).toBe("work");
    expect(BrowserBookmarkStore.getInstance().get(bm.id)).not.toBeNull();
  });

  it("POST validates: missing url → 400, non-array tags → 400", async () => {
    let r = mkRes();
    await handleBrowserBookmarkRoutes("POST", u("/api/browser/bookmarks"), mkReq({ title: "no url" }), r.res, ctx, role);
    expect(r.status()).toBe(400);

    r = mkRes();
    await handleBrowserBookmarkRoutes("POST", u("/api/browser/bookmarks"), mkReq({ url: "https://x.example/", tags: "not-an-array" }), r.res, ctx, role);
    expect(r.status()).toBe(400);
    expect(BrowserBookmarkStore.getInstance().list()).toHaveLength(0);
  });

  it("GET /api/browser/bookmarks lists newest-first with ?q= filter", async () => {
    const store = BrowserBookmarkStore.getInstance();
    store.add({ url: "https://a.example.com/", title: "Alpha", addedBy: "user" });
    store.add({ url: "https://b.example.com/", title: "Beta", addedBy: "agent" });

    let r = mkRes();
    expect(await handleBrowserBookmarkRoutes("GET", u("/api/browser/bookmarks"), mkReq(), r.res, ctx, role)).toBe(true);
    expect((r.body() as BrowserBookmark[]).map((b) => b.title)).toEqual(["Beta", "Alpha"]);

    r = mkRes();
    await handleBrowserBookmarkRoutes("GET", u("/api/browser/bookmarks?q=alpha"), mkReq(), r.res, ctx, role);
    expect((r.body() as BrowserBookmark[]).map((b) => b.title)).toEqual(["Alpha"]);
  });

  it("DELETE /api/browser/bookmarks/:id removes (404 for unknown)", async () => {
    const bm = BrowserBookmarkStore.getInstance().add({ url: "https://example.com/rm", addedBy: "user" });
    let r = mkRes();
    expect(await handleBrowserBookmarkRoutes("DELETE", u(`/api/browser/bookmarks/${bm.id}`), mkReq(), r.res, ctx, role)).toBe(true);
    expect(r.status()).toBe(200);
    expect(BrowserBookmarkStore.getInstance().list()).toHaveLength(0);

    r = mkRes();
    await handleBrowserBookmarkRoutes("DELETE", u("/api/browser/bookmarks/bm-nope"), mkReq(), r.res, ctx, role);
    expect(r.status()).toBe(404);
  });

  it("does not claim other paths or methods", async () => {
    const r = mkRes();
    expect(await handleBrowserBookmarkRoutes("PUT", u("/api/browser/bookmarks"), mkReq(), r.res, ctx, role)).toBe(false);
    expect(await handleBrowserBookmarkRoutes("GET", u("/api/browser/history"), mkReq(), r.res, ctx, role)).toBe(false);
  });
});
