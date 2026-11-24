/**
 * Brand-kit helpers. Branding is the USER's own (logo/company/footer), opt-in
 * via the theme's `brand` block; empty by default so documents carry no
 * branding at all — and never the app's.
 */
import { acquireImages, type AcquiredImage } from "./image-acquire.js";
import type { OfficeTheme } from "./office-theme.js";

/** Which of the brand's images: the logo, the logo for dark grounds (falling
 *  back to the logo), or the full-width letterhead. */
export type BrandImage = "logo" | "logoOnDark" | "letterhead";

/** Fetch one of the user's brand images as an embeddable raster, or null. A
 *  missing or unsupported image must NEVER fail document generation. A brand
 *  library image is read from its brand's folder and nowhere else; any other
 *  source resolves like a file the agent names (URL or workspace path). */
export async function acquireBrandLogo(t: OfficeTheme, which: BrandImage = "logo"): Promise<AcquiredImage | null> {
  const src = (which === "logoOnDark" ? t.brand.logoOnDark || t.brand.logo : t.brand[which])?.trim();
  if (!src) return null;
  try {
    const opts = t.brand.dir ? { workspaceRoot: t.brand.dir } : undefined;
    const [img] = (await acquireImages([{ source: src }], opts)).images;
    if (!img) return null;
    // Only raster types embed cleanly across docx/pdf/pptx.
    if (img.mimeType === "image/png" || img.mimeType === "image/jpeg" || img.mimeType === "image/gif") return img;
    return null;
  } catch {
    return null;
  }
}

/** Scale a logo to a target HEIGHT (px), preserving aspect ratio. */
export function logoSize(img: AcquiredImage, targetH: number): { w: number; h: number } {
  const ratio = img.width > 0 && img.height > 0 ? img.width / img.height : 3;
  return { w: Math.round(targetH * ratio), h: targetH };
}
