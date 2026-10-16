/**
 * The typefaces the design system names, bundled with the install.
 *
 * Every archetype in design-systems.ts names an open-licensed face, and the
 * TYPEFACE rule tells the builder to implement it. Until 2026-10-16 none of
 * them shipped: the preview blocks font CDNs, and the agent has no way to save
 * a binary download, so every app silently rendered the system fallback. The
 * latin subsets now live in public/vendor/fonts/ (Fontsource 5.3.0, each with
 * its OFL.txt) and the app origin serves them at FONT_URL_PREFIX.
 *
 * design-fonts.test.ts fails when an archetype names a face that is not here,
 * or a face here has no stylesheet, font file or license on disk.
 */

/** Where an app page loads a bundled face from (same origin as the app). */
export const FONT_URL_PREFIX = "/vendor/fonts/";

/** Family name exactly as the design system quotes it → stylesheet slug. */
export const BUNDLED_FONTS: Readonly<Record<string, string>> = Object.freeze({
  "Manrope": "manrope",
  "IBM Plex Sans": "ibm-plex-sans",
  "IBM Plex Mono": "ibm-plex-mono",
  "Archivo": "archivo",
  "JetBrains Mono": "jetbrains-mono",
  "Bricolage Grotesque": "bricolage-grotesque",
  "Karla": "karla",
  "Geist": "geist",
  "Fraunces": "fraunces",
  "Nunito Sans": "nunito-sans",
  "Instrument Serif": "instrument-serif",
  "Space Grotesk": "space-grotesk",
  "Plus Jakarta Sans": "plus-jakarta-sans",
  "Sora": "sora",
});

/** Faces a stack may name that every OS already has; never bundled. */
export const SYSTEM_FONTS: ReadonlySet<string> = new Set(["Segoe UI"]);

/** Every quoted family name in a typography line, in order, deduplicated. */
export function quotedFamilies(typography: string): string[] {
  const out: string[] = [];
  for (const m of typography.matchAll(/'([^']+)'/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The <link> tags that load a typography line's bundled faces, or "" when it
 *  names none. */
export function fontLinkTags(typography: string): string {
  return quotedFamilies(typography)
    .map((family) => BUNDLED_FONTS[family])
    .filter((slug): slug is string => Boolean(slug))
    .map((slug) => `<link rel="stylesheet" href="${FONT_URL_PREFIX}${slug}.css">`)
    .join(" ");
}
