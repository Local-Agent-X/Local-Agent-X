import { describe, it, expect } from "vitest";
import {
  resolveOfficeTheme,
  DEFAULT_OFFICE_THEME,
  normalizeHex,
  half,
  argb,
} from "./office-theme.js";

describe("office-theme defaults", () => {
  it("bakes in Modern Slate + Navy", () => {
    expect(DEFAULT_OFFICE_THEME.colors.accent).toBe("1F3A5F");
    expect(DEFAULT_OFFICE_THEME.fonts.body).toBe("Calibri");
    expect(DEFAULT_OFFICE_THEME.fonts.heading).toBe("Calibri");
  });

  it("resolves to the default when no override is given", () => {
    const t = resolveOfficeTheme();
    expect(t.colors.accent).toBe("1F3A5F");
    expect(t.doc.bodySize).toBe(11);
  });
});

describe("office-theme overrides (explicit agent instructions)", () => {
  it("merges a per-call color override and strips a leading #", () => {
    const t = resolveOfficeTheme({ colors: { accent: "#7A2E3A" } });
    expect(t.colors.accent).toBe("7A2E3A");
    // untouched fields fall back to the default
    expect(t.colors.heading).toBe(DEFAULT_OFFICE_THEME.colors.heading);
  });

  it("accepts a JSON string override (tool args arrive as strings)", () => {
    const t = resolveOfficeTheme('{"fonts":{"heading":"Times New Roman"}}');
    expect(t.fonts.heading).toBe("Times New Roman");
    expect(t.fonts.body).toBe("Calibri"); // unspecified → default
  });

  it("replaces the chart palette wholesale and normalizes hexes", () => {
    const t = resolveOfficeTheme({ chartPalette: ["#abcdef", "123456"] });
    expect(t.chartPalette).toEqual(["ABCDEF", "123456"]);
  });

  it("falls back to the default on malformed override JSON", () => {
    const t = resolveOfficeTheme("{not valid json");
    expect(t.colors.accent).toBe("1F3A5F");
  });
});

describe("office-theme unit helpers", () => {
  it("normalizeHex strips # and uppercases", () => {
    expect(normalizeHex("#1f3a5f")).toBe("1F3A5F");
    expect(normalizeHex("aabbcc")).toBe("AABBCC");
  });
  it("half() converts points to docx half-points", () => {
    expect(half(11)).toBe(22);
    expect(half(11.5)).toBe(23);
  });
  it("argb() prefixes FF for exceljs", () => {
    expect(argb("1F3A5F")).toBe("FF1F3A5F");
    expect(argb("#1f3a5f")).toBe("FF1F3A5F");
  });
});
