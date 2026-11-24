/**
 * The agent saves what the user tells it about a company's look into the
 * brand library, where the Office tools apply it from then on.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import { brandTool } from "./brand-tool.js";
import { brandsDir, findBrand } from "./shared/brand-store.js";
import { workspaceRoot } from "../config.js";

const call = (args: Record<string, unknown>) => brandTool.execute(args) as Promise<{ content: string; isError?: boolean }>;

beforeEach(() => {
  rmSync(brandsDir(), { recursive: true, force: true });
  mkdirSync(join(workspaceRoot(), "uploads-in"), { recursive: true });
});

describe("brand tool", () => {
  it("saves a brand from chat and reads it back", async () => {
    const saved = await call({ action: "save", name: "NutriShop", colors: { primary: "#E4572E", secondary: "B5D334" }, fonts: '{"heading":"Montserrat"}', rules: { doc: "Open with the letterhead." }, default: true });
    expect(saved.isError).toBeFalsy();
    expect(saved.content).toMatch(/Saved brand:\nNutriShop \(default brand\)/);
    const got = await call({ action: "get", name: "nutrishop" });
    expect(got.content).toMatch(/primary #E4572E, secondary #B5D334/);
    expect(got.content).toMatch(/Rules for doc: Open with the letterhead/);
    expect((await call({ action: "list" })).content).toMatch(/NutriShop/);
  });

  it("updates an existing brand rather than making a second", async () => {
    await call({ action: "save", name: "NutriShop", footer: "NutriShop" });
    const r = await call({ action: "save", name: "NutriShop", footer: "NutriShop McKinney" });
    expect(r.content).toMatch(/^Updated brand/);
    expect(findBrand("NutriShop")?.footer).toBe("NutriShop McKinney");
  });

  it("copies an attached logo in, and imports a template's colors and fonts", async () => {
    await call({ action: "save", name: "NutriShop" });
    const logoPath = join(workspaceRoot(), "uploads-in", "logo.png");
    writeFileSync(logoPath, await sharp({ create: { width: 40, height: 20, channels: 3, background: "#E4572E" } }).png().toBuffer());
    const added = await call({ action: "add_asset", name: "NutriShop", path: logoPath, role: "logo" });
    expect(added.content).toMatch(/Added logo.png to NutriShop as its logo/);

    const zip = new JSZip();
    zip.file("ppt/theme/theme1.xml", '<a:theme xmlns:a="x"><a:clrScheme><a:accent1><a:srgbClr val="1F5A3A"/></a:accent1></a:clrScheme><a:majorFont><a:latin typeface="Georgia"/></a:majorFont></a:theme>');
    const tpl = join(workspaceRoot(), "uploads-in", "Brand.potx");
    writeFileSync(tpl, await zip.generateAsync({ type: "nodebuffer" }));
    const imported = await call({ action: "import", name: "NutriShop", path: tpl });
    expect(imported.content).toMatch(/Kept it in the brand as Brand.potx/);
    expect(findBrand("NutriShop")).toMatchObject({ colors: { primary: "1F5A3A" }, fonts: { heading: "Georgia" }, logo: "logo.png" });
  });

  it("removes a brand, and says what went wrong in words", async () => {
    await call({ action: "save", name: "Old Co" });
    expect((await call({ action: "remove", name: "Old Co" })).content).toMatch(/in the trash/);
    expect(findBrand("Old Co")).toBeNull();
    expect((await call({ action: "get", name: "Old Co" })).isError).toBe(true);
    expect((await call({ action: "add_asset", name: "Nope", path: "x.png", role: "banner" })).content).toMatch(/role must be one of/);
    expect((await call({ action: "save" })).content).toMatch(/needs the brand's name/);
  });
});
