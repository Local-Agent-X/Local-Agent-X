/**
 * The curated design systems a deck (and, as they adopt it, a document or
 * sheet) is made in. Each is a complete look: palette roles, a font pairing,
 * chart colors, and what it suits. The agent picks the one that fits what it
 * is making and who it is for; a user's brand and an explicit theme still win
 * over it (resolveOfficeTheme).
 *
 * Curated, not generated: the products that do this well pick from systems
 * people designed, because a palette an AI invents tends to look amateur, and
 * every system here is held to the contrast the slide checks demand
 * (office-designs.test.ts). Before 2026-11-23 there was one look, and every
 * deck was navy on white whatever it was for.
 *
 * Fonts are ones every Microsoft Office install carries on Windows and Mac
 * (or the OS does), so a deck opened elsewhere keeps its type.
 */
import type { OfficeTheme } from "./office-theme.js";

export interface OfficeDesign {
  /** Who and what it suits: the agent reads this to choose. */
  suits: string;
  fonts: OfficeTheme["fonts"];
  colors: OfficeTheme["colors"];
  chartPalette: string[];
}

export const OFFICE_DESIGNS = {
  midnight: {
    suits: "investors, finance, board and strategy: navy and gold, confident and sober",
    fonts: { heading: "Calibri", body: "Calibri" },
    colors: {
      heading: "222428", subheading: "2B2F36", body: "23262B", accent: "1F3A5F", accentText: "FFFFFF",
      band: "F2F5F9", border: "D9DEE5", muted: "5E6673",
      slideBackground: "FFFFFF", slideDark: "0F1B2D", onDark: "FFFFFF", onDarkMuted: "B6C2D3", highlight: "D4AF37",
    },
    chartPalette: ["1F3A5F", "3E5C76", "6B8CAE", "A8C0D6", "C9A227", "7A2E3A"],
  },
  harbor: {
    suits: "technology, software and product: deep teal with aqua, clean and modern",
    fonts: { heading: "Century Gothic", body: "Calibri" },
    colors: {
      heading: "10262E", subheading: "1D3B45", body: "1E2B30", accent: "0E5A66", accentText: "FFFFFF",
      band: "EEF6F7", border: "CFE3E6", muted: "51666C",
      slideBackground: "FFFFFF", slideDark: "082A33", onDark: "FFFFFF", onDarkMuted: "BCD8DD", highlight: "3FD0C9",
    },
    chartPalette: ["0E5A66", "1B8A94", "3FD0C9", "8FDCD6", "F2A541", "56636A"],
  },
  evergreen: {
    suits: "health, wellness, nutrition, food and sustainability: forest green with fresh lime, warm serif titles",
    fonts: { heading: "Georgia", body: "Calibri" },
    colors: {
      heading: "1B2A20", subheading: "26382B", body: "212B24", accent: "1F5A3A", accentText: "FFFFFF",
      band: "F1F6EF", border: "D4E3D2", muted: "53655A",
      slideBackground: "FFFFFF", slideDark: "12301F", onDark: "FFFFFF", onDarkMuted: "B5CDB9", highlight: "B5D334",
    },
    chartPalette: ["1F5A3A", "3F8A57", "7FB069", "B5D334", "E3B23C", "8C5E3C"],
  },
  ember: {
    suits: "sales, marketing and launches: charcoal with burnt orange, energetic",
    fonts: { heading: "Franklin Gothic Medium", body: "Calibri" },
    colors: {
      heading: "1F1F1F", subheading: "2E2E2E", body: "262626", accent: "9E3912", accentText: "FFFFFF",
      band: "F7F2EF", border: "E6D8D0", muted: "5E5A57",
      slideBackground: "FFFFFF", slideDark: "1C1C1C", onDark: "FFFFFF", onDarkMuted: "EAE3DE", highlight: "FF7A3D",
    },
    chartPalette: ["9E3912", "E2683A", "F2A65A", "5E5A57", "9C948F", "2E2E2E"],
  },
  graphite: {
    suits: "design, architecture, agencies and premium brands: black and white with one red, minimal",
    fonts: { heading: "Arial", body: "Arial" },
    colors: {
      heading: "111111", subheading: "222222", body: "1A1A1A", accent: "111111", accentText: "FFFFFF",
      band: "F3F3F3", border: "DDDDDD", muted: "5C5C5C",
      slideBackground: "FFFFFF", slideDark: "111111", onDark: "FFFFFF", onDarkMuted: "BDBDBD", highlight: "E63946",
    },
    chartPalette: ["111111", "E63946", "6B6B6B", "A8A8A8", "D4D4D4", "3A3A3A"],
  },
  ledger: {
    suits: "legal, compliance, policy, governance and formal reports: burgundy and ivory, classic serif, restrained",
    fonts: { heading: "Cambria", body: "Cambria" },
    colors: {
      heading: "2A1A1D", subheading: "3A262A", body: "2B2325", accent: "6E1F2E", accentText: "FFFFFF",
      band: "F6F1EE", border: "E2D6D2", muted: "5F5355",
      slideBackground: "FFFFFF", slideDark: "3A1018", onDark: "FFFFFF", onDarkMuted: "DCC3C8", highlight: "C9A86A",
    },
    chartPalette: ["6E1F2E", "9C4A57", "C9A86A", "7D7373", "B9ACA8", "3A262A"],
  },
  studio: {
    suits: "creative work, events, culture and personal brands: plum with coral, expressive",
    fonts: { heading: "Candara", body: "Candara" },
    colors: {
      heading: "24152B", subheading: "33203B", body: "251B29", accent: "5B2A6E", accentText: "FFFFFF",
      band: "F6F0F8", border: "E4D5EA", muted: "5F5464",
      slideBackground: "FFFFFF", slideDark: "2A1033", onDark: "FFFFFF", onDarkMuted: "D3BEDC", highlight: "FF7F6E",
    },
    chartPalette: ["5B2A6E", "8E4FA6", "FF7F6E", "F2B5A7", "3E7CB1", "B9A5C2"],
  },
  sunny: {
    suits: "kids, education, training, community and anything that should feel friendly: royal purple with sunshine yellow, rounded type",
    fonts: { heading: "Trebuchet MS", body: "Trebuchet MS" },
    colors: {
      heading: "1E1A3A", subheading: "2C2752", body: "22203A", accent: "4B2E9E", accentText: "FFFFFF",
      band: "F4F1FD", border: "DDD5F7", muted: "57536E",
      slideBackground: "FFFFFF", slideDark: "35207A", onDark: "FFFFFF", onDarkMuted: "D7CCF5", highlight: "FFD23F",
    },
    chartPalette: ["4B2E9E", "FFD23F", "2EC4B6", "FF6B6B", "7B61FF", "F4A259"],
  },
  ivory: {
    suits: "hospitality, retail, real estate and lifestyle: warm ivory pages, espresso and terracotta, editorial",
    fonts: { heading: "Constantia", body: "Corbel" },
    colors: {
      heading: "2B1E16", subheading: "3A2A20", body: "2E241D", accent: "8A3B22", accentText: "FFFFFF",
      band: "EFE6D8", border: "DDCFBA", muted: "5F5348",
      slideBackground: "FBF7F0", slideDark: "2E1F16", onDark: "FBF7F0", onDarkMuted: "D8C8B4", highlight: "E08A5E",
    },
    chartPalette: ["8A3B22", "C0643F", "E08A5E", "B79F7E", "6B5544", "D8C8B4"],
  },
  signal: {
    suits: "AI, developer tools, gaming and bold tech launches: near-black with electric violet and cyan",
    fonts: { heading: "Verdana", body: "Verdana" },
    colors: {
      heading: "0E1020", subheading: "1A1D33", body: "151827", accent: "4C2BD9", accentText: "FFFFFF",
      band: "F1EFFC", border: "D9D3F7", muted: "565A72",
      slideBackground: "FFFFFF", slideDark: "0A0C18", onDark: "FFFFFF", onDarkMuted: "D2D5EE", highlight: "3DE0F5",
    },
    chartPalette: ["4C2BD9", "3DE0F5", "9B7BFF", "1B9AAA", "F25F9A", "565A72"],
  },
} as const satisfies Record<string, OfficeDesign>;

export type OfficeDesignName = keyof typeof OFFICE_DESIGNS;
export const OFFICE_DESIGN_NAMES = Object.keys(OFFICE_DESIGNS) as OfficeDesignName[];

export function isOfficeDesignName(v: unknown): v is OfficeDesignName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(OFFICE_DESIGNS, v);
}
