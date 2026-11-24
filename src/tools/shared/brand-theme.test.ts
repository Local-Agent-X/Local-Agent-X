/**
 * Which brand a file is made in, and what the brand does to its theme: the
 * one the call names, "none", or the user's default; its colors repaint the
 * design, its images are read from its own folder, and an explicit `theme`
 * still wins over it.
 */
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { brandForCall, brandNote } from "./brand-theme.js";
import { brandDir, brandsDir, findBrand, saveBrand } from "./brand-store.js";
import { addBrandFile } from "./brand-files.js";
import { designTheme, resolveOfficeTheme, DEFAULT_OFFICE_THEME } from "./office-theme.js";
import { acquireBrandLogo } from "./office-brand.js";

beforeEach(() => rmSync(brandsDir(), { recursive: true, force: true }));

describe("brandForCall", () => {
  it("is no brand when nothing is saved and nothing is named, so files look as before", () => {
    expect(brandForCall(undefined, "deck")).toEqual({ brand: null, note: "" });
    expect(resolveOfficeTheme(undefined, undefined, null)).toEqual(DEFAULT_OFFICE_THEME);
  });

  it("takes the brand the call names, and refuses one that is not saved, naming the saved ones", () => {
    saveBrand({ name: "NutriShop" });
    const made = brandForCall("nutrishop", "doc");
    expect("brand" in made && made.brand?.name).toBe("NutriShop");
    const miss = brandForCall("Acme", "doc");
    expect("error" in miss && miss.error).toMatch(/No saved brand "Acme". Saved brands: NutriShop/);
  });

  it("falls back to the default brand, and \"none\" makes a file unbranded anyway", () => {
    saveBrand({ name: "Home", isDefault: true });
    const fallback = brandForCall(undefined, "pdf");
    expect("brand" in fallback && fallback.brand?.name).toBe("Home");
    expect(brandForCall("none", "pdf")).toEqual({ brand: null, note: "" });
  });

  it("tells the agent the brand's rules for this kind of file, and to check against them", () => {
    const b = saveBrand({ name: "NutriShop", notes: "Always NutriShop, one word.", rules: { doc: "Open with the letterhead.", deck: "Lime only as a highlight." } });
    const note = brandNote(b, "doc");
    expect(note).toMatch(/Always NutriShop, one word/);
    expect(note).toMatch(/rules for documents: Open with the letterhead/);
    expect(note).not.toMatch(/Lime only/);
    expect(note).toMatch(/Check the file against these rules/);
  });
});

describe("resolveOfficeTheme with a brand", () => {
  it("repaints the design in the brand's colors and fonts, and keeps a call's theme on top", () => {
    const b = saveBrand({ name: "NutriShop", colors: { primary: "E4572E" }, fonts: { heading: "Montserrat" }, footer: "NutriShop McKinney" });
    const t = resolveOfficeTheme(undefined, "harbor", b);
    expect(t.colors.accent).not.toBe(designTheme("harbor").colors.accent);
    expect(t.fonts.heading).toBe("Montserrat");
    expect(t.fonts.body).toBe(designTheme("harbor").fonts.body);
    expect(t.brand.footer).toBe("NutriShop McKinney");
    expect(t.brand.dir).toBe(brandDir(b.slug));
    const over = resolveOfficeTheme('{"colors":{"accent":"#000000"},"brand":{"dir":"C:/elsewhere"}}', "harbor", b);
    expect(over.colors.accent).toBe("000000");
    expect(over.brand.dir).toBe(brandDir(b.slug));
  });

  it("a brand with no colors leaves the design's colors", () => {
    const b = saveBrand({ name: "Plain", footer: "Plain Co" });
    expect(resolveOfficeTheme(undefined, "ember", b).colors).toEqual(designTheme("ember").colors);
  });

  it("reads the brand's logo from its folder, and the dark-ground logo falls back to it", async () => {
    saveBrand({ name: "NutriShop" });
    const logo = await sharp({ create: { width: 60, height: 20, channels: 3, background: "#E4572E" } }).png().toBuffer();
    await addBrandFile("NutriShop", { name: "logo.png", data: logo }, "logo");
    const t = resolveOfficeTheme(undefined, undefined, findBrand("NutriShop"));
    expect((await acquireBrandLogo(t))?.width).toBe(60);
    expect((await acquireBrandLogo(t, "logoOnDark"))?.width).toBe(60);
    expect(await acquireBrandLogo(t, "letterhead")).toBeNull();
  });
});
