/**
 * Brand-kit helpers. Branding is the USER's own (logo/company/footer), opt-in
 * via the theme's `brand` block; empty by default so documents carry no
 * branding at all — and never the app's.
 */
import { acquireImages, type AcquiredImage } from "./image-acquire.js";
import type { OfficeTheme } from "./office-theme.js";

/** Fetch the user's brand logo as an embeddable raster, or null. A missing or
 *  unsupported logo must NEVER fail document generation. */
export async function acquireBrandLogo(t: OfficeTheme): Promise<AcquiredImage | null> {
  const src = t.brand.logo?.trim();
  if (!src) return null;
  try {
    const [img] = await acquireImages([{ source: src }]);
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
