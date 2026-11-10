/**
 * A card's picture, found by the card tool itself, never chosen by the model:
 * the same card gets the same kind of picture in a typed chat and on a call.
 *
 * Before (2026-11-09): the model was told to open each store page in the
 * browser and pick a picture, so typed chats showed photos (10-20 s of browsing)
 * and calls, told to be quick, showed none.
 *
 * For a card with a link, in order:
 *   1. a web image search for the card's title, pictures on the link's own site
 *      first. The search engine's copy is tried before the store's, because
 *      stores refuse a server fetch and the engine's copy serves everyone;
 *   2. the link's page itself, read in a hidden one-off browser tab
 *      (browser/page-picture.ts): its preview image;
 *   3. the picture the model passed, if any.
 * A card without a link uses the picture the model passed. A card for which
 * nothing works is shown without one.
 */
import type { ImageHit } from "./image-search-tool.js";

export const SEARCH_TIMEOUT_MS = 6_000;
const SEARCH_RESULTS = 6;
const OTHER_SITE_TRIES = 2;

export interface CardPictureSources {
  search: (query: string, max: number, signal: AbortSignal) => Promise<ImageHit[]>;
  page: (url: string, onBehalfOf: string) => Promise<string | null>;
  /** Fetch and keep a picture; returns its served /images path or throws. */
  save: (source: string) => Promise<string>;
}

/** The served path of the card's picture, or null when none could be found. */
export async function findCardPicture(
  card: { title: string; links?: Array<{ url: string }> },
  modelImage: string | undefined,
  sessionId: string,
  sources: CardPictureSources,
): Promise<string | null> {
  const link = card.links?.[0]?.url;
  if (link) {
    const hits = await sources.search(card.title, SEARCH_RESULTS, AbortSignal.timeout(SEARCH_TIMEOUT_MS)).catch(() => []);
    for (const hit of picturesToTry(hits, link)) {
      const saved = await firstSaved(sources, [hit.fallback, hit.url]);
      if (saved) return saved;
    }
    const fromPage = await sources.page(link, sessionId).catch(() => null);
    const saved = await firstSaved(sources, [fromPage ?? undefined]);
    if (saved) return saved;
  }
  return firstSaved(sources, [modelImage]);
}

/** Search hits worth trying: every one on the link's own site, then the top
 *  couple from elsewhere. */
export function picturesToTry(hits: ImageHit[], link: string): ImageHit[] {
  const site = siteOf(link);
  const own = hits.filter((h) => h.page !== undefined && site !== null && siteOf(h.page) === site);
  const other = hits.filter((h) => !own.includes(h)).slice(0, OTHER_SITE_TRIES);
  return [...own, ...other];
}

/** A host without its leading www., so amazon.com and www.amazon.com match. */
function siteOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function firstSaved(sources: CardPictureSources, candidates: Array<string | undefined>): Promise<string | null> {
  for (const source of candidates) {
    if (!source) continue;
    try {
      return await sources.save(source);
    } catch { /* that copy could not be fetched or is not a picture: try the next */ }
  }
  return null;
}
