/**
 * A brand's files live in its own folder: copied in, never pointed at, so a
 * cleared uploads folder cannot break a brand. A logo of any image type ends
 * up as one Office files can embed; removing goes to the trash; removing a
 * brand tells the user's other machines to drop it too.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { getLaxDir } from "../../lax-data-dir.js";
import { addBrandFile, removeBrand, removeBrandFile } from "./brand-files.js";
import { brandDir, brandsDir, findBrand, saveBrand } from "./brand-store.js";

const png = () => sharp({ create: { width: 40, height: 20, channels: 3, background: "#E4572E" } }).png().toBuffer();
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#1F5A3A"/></svg>');

beforeEach(() => {
  rmSync(brandsDir(), { recursive: true, force: true });
  rmSync(join(getLaxDir(), "sync-repo"), { recursive: true, force: true });
  saveBrand({ name: "Acme" });
});

describe("brand files", () => {
  it("stores a logo under its role and records it on the brand", async () => {
    const { file } = await addBrandFile("Acme", { name: "Acme Logo.png", data: await png() }, "logo");
    expect(file).toBe("logo.png");
    expect(findBrand("Acme")?.logo).toBe("logo.png");
    expect(existsSync(join(brandDir("acme"), "logo.png"))).toBe(true);
  });

  it("turns an SVG letterhead into a PNG an Office file can embed", async () => {
    const { file } = await addBrandFile("Acme", { name: "header.svg", data: svg }, "letterhead");
    expect(file).toBe("letterhead.png");
    const meta = await sharp(readFileSync(join(brandDir("acme"), file))).metadata();
    expect(meta.format).toBe("png");
  });

  it("replacing a logo of another type leaves one logo", async () => {
    await addBrandFile("Acme", { name: "a.png", data: await png() }, "logo");
    await addBrandFile("Acme", { name: "b.svg", data: svg }, "logo");
    expect(readdirSync(brandDir("acme")).filter((f) => f.startsWith("logo."))).toEqual(["logo.png"]);
  });

  it("keeps templates under a safe, unique name with their note", async () => {
    const data = Buffer.from("PK fake");
    const a = await addBrandFile("Acme", { name: "Sales Deck (2026).potx", data }, "template", "for sales decks");
    const b = await addBrandFile("Acme", { name: "Sales Deck (2026).potx", data }, "template");
    expect(a.file).toBe("Sales-Deck-2026.potx");
    expect(b.file).toBe("Sales-Deck-2026-2.potx");
    expect(findBrand("Acme")?.assets[0]).toEqual({ file: "Sales-Deck-2026.potx", kind: "template", note: "for sales decks" });
  });

  it("refuses the wrong kind of file for a role, and files too big to sync", async () => {
    await expect(addBrandFile("Acme", { name: "x.pdf", data: Buffer.from("%PDF") }, "logo")).rejects.toThrow(/must be an image/);
    await expect(addBrandFile("Acme", { name: "x.exe", data: Buffer.from("MZ") }, "reference")).rejects.toThrow(/can be/);
    await expect(addBrandFile("Acme", { name: "x.png", data: Buffer.alloc(10_000_001) }, "image")).rejects.toThrow(/up to 10 MB/);
    await expect(addBrandFile("Nobody", { name: "x.png", data: await png() }, "logo")).rejects.toThrow(/No saved brand/);
  });

  it("removes one file to the trash and forgets it", async () => {
    await addBrandFile("Acme", { name: "a.png", data: await png() }, "logo");
    await removeBrandFile("Acme", "logo.png");
    expect(findBrand("Acme")?.logo).toBeUndefined();
    expect(existsSync(join(brandDir("acme"), "logo.png"))).toBe(false);
    await expect(removeBrandFile("Acme", "brand.json")).rejects.toThrow(/has no file/);
  });

  it("removes a whole brand to the trash and leaves a tombstone for sync", async () => {
    mkdirSync(join(getLaxDir(), "sync-repo"), { recursive: true });
    await removeBrand("Acme");
    expect(findBrand("Acme")).toBeNull();
    expect(existsSync(join(getLaxDir(), "trash"))).toBe(true);
    expect(existsSync(join(getLaxDir(), "sync-repo", ".tombstones", "brands", "acme.json"))).toBe(true);
  });
});
