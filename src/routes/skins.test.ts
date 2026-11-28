/**
 * Settings → Appearance → My themes over HTTP: the user makes a theme, gives
 * it a background through the ordinary upload, and deletes it. Each change
 * tells open windows to repaint; the agent principal is refused (it has its
 * own skin tool).
 */
import { Readable } from "node:stream";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../server-context.js";
import type { Role } from "../rbac.js";
import { uploadsDir } from "../config.js";
import { loadSettings, setSetting } from "../settings.js";
import { findSkin, skinsDir } from "../skins/skin-store.js";
import { activeSkinSlug, handleSkinRoutes } from "./skins.js";

const broadcastAll = vi.fn();

async function call(method: string, path: string, body?: unknown, role: Role = "operator") {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  const res = { statusCode: 0, body: "", writeHead(s: number) { res.statusCode = s; return res; }, setHeader() {}, end(b?: string) { if (b) res.body = b; return res; } };
  const ctx = { broadcastAll } as unknown as ServerContext;
  const handled = await handleSkinRoutes(method, new URL(`http://x${path}`), req as never, res as never, ctx, role);
  return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
  rmSync(skinsDir(), { recursive: true, force: true });
  setSetting("skin", "");
  broadcastAll.mockReset();
});

describe("/api/skins", () => {
  it("saves a theme, lists it with the effects the page can draw, and tells open windows", async () => {
    const saved = await call("POST", "/api/skins/save", { skin: { name: "Winter Lodge", opacity: 0.5, slug: "../evil", background: "../x.png", effect: { kind: "snow" } } });
    expect(saved.status).toBe(200);
    expect(saved.body.skin).toMatchObject({ name: "Winter Lodge", slug: "winter-lodge", opacity: 0.5, effect: { kind: "snow" } });
    expect(saved.body.skin.background).toBeUndefined();
    expect(broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { skins: true } });
    const listed = await call("GET", "/api/skins", undefined, "readonly");
    expect(listed.body).toMatchObject({ active: "", skins: [{ slug: "winter-lodge" }] });
    expect(listed.body.effects).toContain("snow");
  });

  it("copies an uploaded picture in as the background, and takes it out again", async () => {
    await call("POST", "/api/skins/save", { skin: { name: "Beach" } });
    mkdirSync(uploadsDir(), { recursive: true });
    writeFileSync(join(uploadsDir(), "abc123.png"), Buffer.from("png-bytes"));
    const set = await call("POST", "/api/skins/background", { skin: "beach", upload: "/uploads/abc123.png", name: "sunset.png" });
    expect(set.body.skin.background).toBe("background.png");
    expect((await call("POST", "/api/skins/background", { skin: "beach", upload: "/uploads/../settings.json", name: "x.png" })).status).toBe(400);
    expect((await call("POST", "/api/skins/remove-background", { skin: "beach" })).body.skin.background).toBeUndefined();
  });

  it("reports the skin that is on, and goes back to the built-in look when it is deleted", async () => {
    await call("POST", "/api/skins/save", { skin: { name: "Beach" } });
    setSetting("skin", "beach");
    expect(activeSkinSlug()).toBe("beach");
    expect((await call("GET", "/api/skins")).body.active).toBe("beach");
    expect((await call("POST", "/api/skins/remove", { skin: "Beach" })).status).toBe(200);
    expect(findSkin("beach")).toBeNull();
    expect((loadSettings() as Record<string, unknown>).skin).toBe("");
    // A setting naming a skin that is gone reads as none.
    setSetting("skin", "beach");
    expect(activeSkinSlug()).toBe("");
  });

  it("refuses the agent, a read-only caller's changes, and an unknown theme", async () => {
    expect((await call("GET", "/api/skins", undefined, "agent")).status).toBe(403);
    expect((await call("POST", "/api/skins/save", { skin: { name: "X" } }, "readonly")).status).toBe(403);
    expect((await call("POST", "/api/skins/remove", { skin: "nope" })).status).toBe(404);
    expect((await call("POST", "/api/skins/save", { skin: {} })).status).toBe(400);
    expect(broadcastAll).not.toHaveBeenCalled();
  });
});
