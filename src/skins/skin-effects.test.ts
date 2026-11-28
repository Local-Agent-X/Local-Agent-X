/**
 * The seam between the server and the window: the effects a skin may name
 * (skin-store.ts) are exactly the ones the page can draw, and a skin's own
 * code only ever reaches the sandboxed frame.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKIN_BUILTIN_EFFECTS } from "./skin-store.js";
import { PREFERENCE_SETTINGS } from "../settings-schema.preferences.js";

const page = (file: string) => readFileSync(join(process.cwd(), "public", file), "utf-8");
const registered = (file: string) => [...page(file).matchAll(/fx\.register\('([a-z-]+)'/g)].map((m) => m[1]);

describe("skin effects", () => {
  it("the page registers every effect the server accepts, and no other", () => {
    const drawn = [...registered("js/skin-effects-builtin.js"), ...registered("js/phrase-rain.js")];
    expect(drawn.sort()).toEqual([...SKIN_BUILTIN_EFFECTS].sort());
  });

  it("the page loads the effect host before the effects, and the skin layer after them", () => {
    const html = page("app.html");
    const at = (name: string) => html.indexOf(`/js/${name}.js`);
    for (const name of ["shared-theme", "skin-effects", "skin-effects-builtin", "phrase-rain", "skin-effect-frame", "skin"]) expect(at(name), name).toBeGreaterThan(0);
    expect(at("shared-theme")).toBeLessThan(at("skin-effects"));
    expect(at("skin-effects")).toBeLessThan(at("skin-effects-builtin"));
    expect(at("skin-effects")).toBeLessThan(at("phrase-rain"));
    expect(at("skin-effect-frame")).toBeLessThan(at("skin"));
  });

  it("a skin's own code runs only in a frame with no origin and no network", () => {
    const frame = page("js/skin-effect-frame.js");
    expect(frame).toMatch(/setAttribute\('sandbox', 'allow-scripts'\)/);
    expect(frame).not.toMatch(/setAttribute\('sandbox', '[^']*allow-same-origin/);
    expect(frame).toMatch(/default-src \\'none\\'/);
    // Nothing else on the page evaluates it.
    for (const file of ["js/skin.js", "js/skin-effects.js", "js/settings-skins.js"]) {
      expect(page(file), file).not.toMatch(/\beval\(|new Function\(|createElement\('script'\)/);
    }
  });

  it("the panels go see-through without making the colors themselves transparent", () => {
    // The desktop title bar and the phone's status bar are painted from
    // --surface and --bg (shared-theme.js); the skin layer writes them as hex.
    const skin = page("js/skin.js");
    expect(skin).toMatch(/v\['--bg'\] = '#' \+ bg; v\['--surface'\] = '#' \+ surface/);
    expect(page("css/app.css")).toMatch(/color-mix\(in srgb, var\(--surface\) var\(--panel-solid,82%\), transparent\)/);
  });

  it("a skin's background replaces the built-in hero art instead of sitting on top of it", () => {
    expect(page("css/app.css")).toMatch(/body\.skin-on #chat-bg\{display:none\}/);
    // skin-on is set only when the skin has a background of its own.
    expect(page("js/skin.js")).toMatch(/classList\.toggle\('skin-on', !!\(skin && skin\.background\)\)/);
  });

  it("the active skin is its own setting, so the appearance default can never reset it", () => {
    const skin = PREFERENCE_SETTINGS.find((s) => s.field === "skin")!;
    expect(skin).toMatchObject({ owner: "agent", broadcast: true });
    expect(skin.validate.safeParse("winter-lodge").success).toBe(true);
    expect(skin.validate.safeParse("").success).toBe(true);
    expect(skin.validate.safeParse("../x").success).toBe(false);
    const palette = PREFERENCE_SETTINGS.find((s) => s.field === "palette")!;
    expect(palette.validate.safeParse("winter-lodge").success).toBe(false);
  });
});
