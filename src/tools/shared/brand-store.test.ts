/**
 * The brand library holds each company's look once, so the documents made
 * for it come out in it. What it must keep true: a brand reads back as it
 * was saved, nothing in brand.json can carry a path or a malformed color
 * into a document, one brand at most is the default, and the look a user set
 * before the library existed becomes a brand rather than vanishing.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getLaxDir } from "../../lax-data-dir.js";
import {
  _resetBrandMigrationForTest, brandDir, brandHex, brandSlug, brandsDir, defaultBrand, findBrand, listBrands, normalizeBrand, saveBrand,
} from "./brand-store.js";

beforeEach(() => {
  rmSync(brandsDir(), { recursive: true, force: true });
  rmSync(join(getLaxDir(), "office-theme.json"), { force: true });
  rmSync(join(getLaxDir(), "office-theme.json.migrated"), { force: true });
  _resetBrandMigrationForTest();
});

describe("brand store", () => {
  it("saves a brand and reads it back by name, slug or alias, in any case", () => {
    saveBrand({ name: "NutriShop McKinney", aliases: ["the store"], colors: { primary: "#e4572e" }, fonts: { heading: "Montserrat" } });
    const b = findBrand("nutrishop mckinney")!;
    expect(b.slug).toBe("nutrishop-mckinney");
    expect(b.colors.primary).toBe("E4572E");
    expect(b.fonts.heading).toBe("Montserrat");
    expect(findBrand("The Store")?.name).toBe("NutriShop McKinney");
    expect(findBrand("nutrishop-mckinney")?.name).toBe("NutriShop McKinney");
    expect(findBrand("nobody")).toBeNull();
  });

  it("changes only the fields given, and clears a field given as empty", () => {
    saveBrand({ name: "Acme", colors: { primary: "112233", secondary: "445566" }, footer: "Acme Inc." });
    saveBrand({ colors: { secondary: "" }, notes: "Never abbreviate the name." }, "Acme");
    const b = findBrand("Acme")!;
    expect(b.colors).toEqual({ primary: "112233" });
    expect(b.footer).toBe("Acme Inc.");
    expect(b.notes).toBe("Never abbreviate the name.");
  });

  it("renames without moving the folder, and gives a second brand of the same name its own folder", () => {
    const first = saveBrand({ name: "Acme" });
    saveBrand({ name: "Acme Corp" }, "Acme");
    expect(findBrand("Acme Corp")?.slug).toBe(first.slug);
    const second = saveBrand({ name: "acme" });
    expect(second.slug).toBe("acme-2");
  });

  it("keeps at most one default brand", () => {
    saveBrand({ name: "One", isDefault: true });
    saveBrand({ name: "Two", isDefault: true });
    expect(listBrands().filter((b) => b.isDefault).map((b) => b.name)).toEqual(["Two"]);
    expect(defaultBrand()?.name).toBe("Two");
  });

  it("refuses to change a brand that does not exist, or create one without a name", () => {
    expect(() => saveBrand({ footer: "x" }, "Ghost")).toThrow(/No saved brand/);
    expect(() => saveBrand({ footer: "x" })).toThrow(/needs a name/);
  });

  it("drops anything in brand.json that could reach outside the folder or break a document", () => {
    const b = normalizeBrand({
      name: "Evil", logo: "../../secrets.enc", letterhead: "C:\\Windows\\x.png", colors: { primary: "red", dark: "#0a0a0a" },
      fonts: { heading: "Arial\"; color: red" }, assets: [{ file: "../x.pdf", kind: "template" }, { file: "deck.potx", kind: "nope" }],
    }, "evil")!;
    expect(b.logo).toBeUndefined();
    expect(b.letterhead).toBeUndefined();
    expect(b.colors).toEqual({ dark: "0A0A0A" });
    expect(b.fonts.heading).toBe("Arial color red");
    expect(b.assets).toEqual([{ file: "deck.potx", kind: "reference" }]);
  });

  it("skips a folder whose brand.json is unreadable", () => {
    mkdirSync(join(brandsDir(), "broken"), { recursive: true });
    writeFileSync(join(brandsDir(), "broken", "brand.json"), "{not json");
    saveBrand({ name: "Fine" });
    expect(listBrands().map((b) => b.name)).toEqual(["Fine"]);
  });

  it("turns the look set before the library existed into a default brand, once", () => {
    writeFileSync(join(getLaxDir(), "office-theme.json"), JSON.stringify({
      colors: { accent: "#7A2E3A", heading: "111111" }, fonts: { heading: "Georgia" }, brand: { company: "Peter Co", footer: "Peter Co · McKinney" },
    }));
    const [b] = listBrands();
    expect(b).toMatchObject({ name: "Peter Co", isDefault: true, colors: { primary: "7A2E3A", dark: "111111" }, fonts: { heading: "Georgia" }, footer: "Peter Co · McKinney" });
    expect(existsSync(join(getLaxDir(), "office-theme.json"))).toBe(false);
    expect(existsSync(join(getLaxDir(), "office-theme.json.migrated"))).toBe(true);
    expect(JSON.parse(readFileSync(join(brandDir(b.slug), "brand.json"), "utf-8")).name).toBe("Peter Co");
  });

  it("makes slugs and hex colors safe", () => {
    expect(brandSlug("  Café & Co!! ")).toBe("caf-co");
    expect(brandSlug("!!!")).toBe("brand");
    expect(brandHex("#abc")).toBe("AABBCC");
    expect(brandHex("zzzzzz")).toBeUndefined();
  });
});
