/**
 * Every face the design system names is actually shipped.
 *
 * Until 2026-10-16 the design system told the builder to implement Manrope,
 * Fraunces, Geist… and none of them were on disk, so every app quietly fell
 * back to the system stack the TYPEFACE rule forbids. Nothing failed. These
 * tests make the gap loud: a new archetype face with no files, a stylesheet
 * pointing at a missing file, or a face shipped without its license fails here.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHETYPES, NEUTRAL_ARCHETYPE } from "./design-systems.js";
import { BUNDLED_FONTS, SYSTEM_FONTS, FONT_URL_PREFIX, quotedFamilies, fontLinkTags } from "./design-fonts.js";
import { selectDesignBrief } from "./design-brief.js";

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "vendor", "fonts");
const ALL = [NEUTRAL_ARCHETYPE, ...ARCHETYPES];

describe("the design system names only faces that ship", () => {
  it.each(ALL.map((a) => [a.id, a.typography]))("%s: every quoted face is bundled or a system font", (_id, typography) => {
    const families = quotedFamilies(typography);
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      expect(BUNDLED_FONTS[family] !== undefined || SYSTEM_FONTS.has(family), `'${family}' is named but not bundled`).toBe(true);
    }
  });

  it.each(ALL.map((a) => [a.id, a.typography]))("%s: the brief carries the tags that load its faces", (_id, typography) => {
    const tags = fontLinkTags(typography);
    expect(tags).toMatch(new RegExp(`href="${FONT_URL_PREFIX}[a-z-]+\\.css"`));
  });

  it("the rendered brief hands the builder the link tags", () => {
    const brief = selectDesignBrief("").brief;
    expect(brief).toContain(`<link rel="stylesheet" href="${FONT_URL_PREFIX}manrope.css">`);
    expect(brief).toMatch(/nothing from a font CDN/);
  });
});

describe("every bundled face is complete on disk", () => {
  it.each(Object.entries(BUNDLED_FONTS))("%s: stylesheet, font files and license", (family, slug) => {
    const cssPath = join(FONTS_DIR, `${slug}.css`);
    expect(existsSync(cssPath), `${slug}.css is missing`).toBe(true);
    const css = readFileSync(cssPath, "utf-8");
    expect(css, "the stylesheet must declare the name the design system quotes").toContain(`font-family: '${family}';`);
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      const file = resolve(FONTS_DIR, u);
      expect(file.startsWith(join(FONTS_DIR, slug)), `${u} leaves the face's folder`).toBe(true);
      expect(existsSync(file), `${u} is missing`).toBe(true);
      expect(readFileSync(file).subarray(0, 4).toString("latin1"), `${u} is not woff2`).toBe("wOF2");
    }
    const license = join(FONTS_DIR, slug, "OFL.txt");
    expect(existsSync(license), `${slug}/OFL.txt is missing`).toBe(true);
    expect(readFileSync(license, "utf-8")).toContain("SIL Open Font License");
  });

  it("nothing is shipped that the table doesn't name", () => {
    const slugs = new Set(Object.values(BUNDLED_FONTS));
    for (const entry of readdirSync(FONTS_DIR)) {
      if (entry === "README.md") continue;
      expect(slugs.has(entry.replace(/\.css$/, "")), `${entry} is not in BUNDLED_FONTS`).toBe(true);
    }
  });
});
