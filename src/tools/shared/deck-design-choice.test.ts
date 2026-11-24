/**
 * How a deck gets its design. Every deck was navy on white whatever it was
 * for; now the agent names the design that fits, and a deck it names none
 * for still does not come out like the last one.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getLaxDir } from "../../lax-data-dir.js";
import { GENERAL_DESIGNS, chooseDeckDesign, designNote, noteDeckDesign, DESIGN_PARAM_SCHEMA } from "./deck-design-choice.js";
import { OFFICE_DESIGN_NAMES } from "./office-designs.js";
import { designTheme, resolveOfficeTheme, DEFAULT_OFFICE_THEME } from "./office-theme.js";

beforeEach(() => rmSync(join(getLaxDir(), "deck-designs.json"), { force: true }));

describe("chooseDeckDesign", () => {
  it("takes the design the agent named", () => {
    expect(chooseDeckDesign("ledger")).toEqual({ name: "ledger", by: "named" });
  });

  it("gives decks with no design different general-purpose designs in turn", () => {
    const seen: string[] = [];
    for (let i = 0; i < GENERAL_DESIGNS.length; i++) {
      const c = chooseDeckDesign(undefined);
      expect(c.by).toBe("rotation");
      seen.push(c.name);
      noteDeckDesign(c.name);
    }
    expect(new Set(seen).size).toBe(GENERAL_DESIGNS.length);
    // Once all were used, the least recently used comes back first.
    expect(chooseDeckDesign(undefined).name).toBe(seen[0]);
  });

  it("never picks a specialist design on its own", () => {
    for (const name of ["ledger", "sunny", "ivory", "studio", "signal"] as const) noteDeckDesign(name);
    expect(GENERAL_DESIGNS).toContain(chooseDeckDesign(undefined).name);
  });

  it("rotates an unnamed deck through the designs its purpose suits", () => {
    const first = chooseDeckDesign(undefined, false, "legal");
    expect(first).toEqual({ name: "ledger", by: "rotation" });
    noteDeckDesign(first.name);
    expect(chooseDeckDesign(undefined, false, "legal").name).toBe("graphite");
  });

  it("gives a slide added to a deck that deck's design", () => {
    noteDeckDesign("evergreen");
    expect(chooseDeckDesign(undefined, true)).toEqual({ name: "evergreen", by: "continued" });
  });

  it("treats an unknown name as none, and says so", () => {
    const c = chooseDeckDesign("neon-dreams");
    expect(c.by).toBe("rotation");
    expect(designNote(c, "neon-dreams")).toMatch(/"neon-dreams" is not a design/);
  });
});

describe("the design parameter", () => {
  it("lists every design with what it suits, as an enum", () => {
    expect(DESIGN_PARAM_SCHEMA.enum).toEqual(OFFICE_DESIGN_NAMES);
    for (const n of OFFICE_DESIGN_NAMES) expect(DESIGN_PARAM_SCHEMA.description).toContain(`${n}: `);
  });
});

describe("resolveOfficeTheme with a design", () => {
  it("builds on the design, and an explicit theme still wins over it", () => {
    const t = resolveOfficeTheme(undefined, "evergreen");
    expect(t.fonts.heading).toBe("Georgia");
    expect(t.colors.accent).toBe(designTheme("evergreen").colors.accent);
    const overridden = resolveOfficeTheme(JSON.stringify({ colors: { accent: "#123456" } }), "evergreen");
    expect(overridden.colors.accent).toBe("123456");
    expect(overridden.fonts.heading).toBe("Georgia");
  });

  it("is the house style with no design or an unknown one", () => {
    expect(designTheme(undefined)).toBe(DEFAULT_OFFICE_THEME);
    expect(designTheme("nope")).toBe(DEFAULT_OFFICE_THEME);
  });
});
