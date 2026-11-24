/**
 * Settings → Brands over HTTP: the user saves a company's look, adds its
 * logo and templates through the ordinary upload, and reads colors in from a
 * template. Each change tells open pages to redraw; the agent principal is
 * refused (it has its own brand tool).
 */
import { Readable } from "node:stream";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../server-context.js";
import type { Role } from "../rbac.js";
import { uploadsDir } from "../config.js";
import { brandsDir, findBrand } from "../tools/shared/brand-store.js";
import { handleBrandRoutes } from "./brands.js";

const broadcastAll = vi.fn();

async function call(method: string, path: string, body?: unknown, role: Role = "operator") {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  const res = { statusCode: 0, body: "", writeHead(s: number) { res.statusCode = s; return res; }, setHeader() {}, end(b?: string) { if (b) res.body = b; return res; } };
  const ctx = { broadcastAll } as unknown as ServerContext;
  const handled = await handleBrandRoutes(method, new URL(`http://x${path}`), req as never, res as never, ctx, role);
  return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
  rmSync(brandsDir(), { recursive: true, force: true });
  broadcastAll.mockReset();
});

describe("/api/brands", () => {
  it("saves a brand, lists it, and tells open pages to redraw", async () => {
    const saved = await call("POST", "/api/brands/save", { brand: { name: "NutriShop", colors: { primary: "#E4572E" }, isDefault: true, slug: "../evil" } });
    expect(saved.status).toBe(200);
    expect(saved.body.brand).toMatchObject({ name: "NutriShop", slug: "nutrishop", isDefault: true, colors: { primary: "E4572E" } });
    expect(broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { brands: true } });
    const listed = await call("GET", "/api/brands", undefined, "readonly");
    expect(listed.body.brands.map((b: { name: string }) => b.name)).toEqual(["NutriShop"]);
  });

  it("copies an uploaded logo into the brand, and reads colors in from it", async () => {
    await call("POST", "/api/brands/save", { brand: { name: "NutriShop" } });
    mkdirSync(uploadsDir(), { recursive: true });
    writeFileSync(join(uploadsDir(), "abc.png"), await sharp({ create: { width: 40, height: 20, channels: 3, background: "#E4572E" } }).png().toBuffer());
    const added = await call("POST", "/api/brands/file", { brand: "NutriShop", upload: "/uploads/abc.png", name: "logo.png", role: "logo" });
    expect(added.body).toMatchObject({ ok: true, file: "logo.png" });
    const imported = await call("POST", "/api/brands/import", { brand: "nutrishop", upload: "/uploads/abc.png", name: "logo.png" });
    expect(imported.body.found.colors.primary).toBe("E4572E");
    expect(findBrand("NutriShop")?.colors.primary).toBe("E4572E");
  });

  it("refuses an upload address that leaves the uploads folder, and a file that is not there", async () => {
    await call("POST", "/api/brands/save", { brand: { name: "NutriShop" } });
    expect((await call("POST", "/api/brands/file", { brand: "NutriShop", upload: "/uploads/../settings.json", name: "x.png", role: "logo" })).status).toBe(400);
    expect((await call("POST", "/api/brands/file", { brand: "NutriShop", upload: "/uploads/missing.png", name: "x.png", role: "logo" })).status).toBe(400);
    expect((await call("POST", "/api/brands/import", { brand: "NutriShop", url: "file:///etc/passwd" })).body.error).toMatch(/http/);
  });

  it("removes a brand, and answers 404 for one that is not saved", async () => {
    await call("POST", "/api/brands/save", { brand: { name: "Old Co" } });
    expect((await call("POST", "/api/brands/remove", { brand: "Old Co" })).body).toMatchObject({ ok: true, removed: "Old Co" });
    expect(findBrand("Old Co")).toBeNull();
    expect((await call("POST", "/api/brands/remove", { brand: "Old Co" })).status).toBe(404);
    expect(broadcastAll).toHaveBeenCalledTimes(2);
  });

  it("refuses the agent, and a read-only role's changes", async () => {
    expect((await call("GET", "/api/brands", undefined, "agent")).status).toBe(403);
    expect((await call("POST", "/api/brands/save", { brand: { name: "X" } }, "readonly")).status).toBe(403);
    expect(broadcastAll).not.toHaveBeenCalled();
  });

  it("leaves other paths to other routes", async () => {
    expect((await call("GET", "/api/brandsx")).handled).toBe(false);
  });
});
