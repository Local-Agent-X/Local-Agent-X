/**
 * Parser-free structural signatures for an HTML document, and the diff between
 * two of them. Pure: no I/O, no DOM, no network — every function here takes a
 * string and returns data, so the whole thing is testable against fixtures.
 *
 * Why this exists. A clone-the-site task ("make our page match theirs") kept
 * failing for 76 turns because the agent compared SCREENSHOTS and patched an
 * override stylesheet. The thing it never checked was whether the two origins
 * even build their mobile page the same way: the original served a separate
 * mobile document, the clone served desktop markup plus an override layer. No
 * amount of CSS tuning converges those, and no screenshot shows it. The signal
 * that ends that task in one call is "does this origin serve a materially
 * DIFFERENT document to a phone than to a desktop?" — which is two fetches and
 * a comparison, not a rendering question.
 *
 * NO VERDICTS. This module reports numbers and lists; it never says "these
 * match" or "this is an override layer". The sibling `layout_report` shipped
 * seven times before that rule stuck, so it is stated here too: a threshold
 * chosen by a developer is a guess, and a guess that reads like a measurement
 * is how a wrong answer gets trusted.
 *
 * LIMITS, stated because they are real:
 *   - The tag sequence is a lexical scan, not a parse. Tags inside <script>,
 *     <style>, comments or attribute values are counted as tags. That is
 *     acceptable for a SIGNATURE (both sides are scanned identically, so the
 *     bias cancels) and is NOT acceptable for anything semantic.
 *   - Headings are matched by regex, so a heading whose text is built by JS is
 *     invisible. A site that renders client-side will look emptier than it is.
 *   - Only server-delivered HTML is seen. A page that switches layout in the
 *     browser (JS or CSS alone) reports identical documents here — which is
 *     itself the answer to "is this device-specific delivery?": no.
 */

/** A tag name that begins an element. Deliberately lexical — see LIMITS. */
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)/g;
const HEADING_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
const LINK_TAG_RE = /<link\b[^>]*>/gi;
const ATTR_RE = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/g;
/**
 * Any .css URL anywhere in the document — link tags, preloads, inline script
 * config, @import in a <style> block.
 *
 * This is the PRIMARY stylesheet signal and the rel="stylesheet" list below is
 * secondary, which is the opposite of what this file shipped with. Measured on
 * the real site this tool was built for: it delivers 12 <link> tags, 20 inline
 * <style> blocks, and ZERO rel="stylesheet" — so a rel-gated extractor reported
 * "no stylesheets" for a page with a dozen of them. A false empty is worse than
 * a missing field, because it reads like an answer.
 */
const CSS_URL_RE = /[\w\-./:]+\.css\b/gi;

/** Collapse markup and whitespace inside a heading to its visible text. */
function textOf(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tag)) !== null) {
    out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  }
  return out;
}

export interface StylesheetRef {
  href: string;
  /** The `media` attribute verbatim, or null when absent. A mobile-only sheet
   *  usually announces itself here or in its filename. */
  media: string | null;
}

export interface PageStructure {
  /** Every element's tag name in document order. The document's shape. */
  tagSequence: string[];
  /** Visible heading text, h1-h6, in document order. */
  headings: string[];
  /** Declared `<link rel="stylesheet">` tags, in document order. Empty on
   *  platforms that never emit one — see cssReferences. */
  stylesheets: StylesheetRef[];
  /** Every .css URL referenced anywhere in the document, de-duplicated, in
   *  first-seen order, filename only (the host and hash path are noise for a
   *  comparison and make the output unreadable). This is what reveals
   *  device-specific delivery: an origin that serves a phone a different
   *  stylesheet SET is building its mobile page differently, whatever the
   *  markup looks like. */
  cssReferences: string[];
}

/** Filename of a URL-ish string, for comparison. `/a/b/x.min.css` → `x.min.css` */
function basename(ref: string): string {
  const clean = ref.split("?")[0].split("#")[0];
  const last = clean.split("/").pop() ?? clean;
  return last || clean;
}

export function extractStructure(html: string): PageStructure {
  const tagSequence: string[] = [];
  TAG_RE.lastIndex = 0;
  let t: RegExpExecArray | null;
  while ((t = TAG_RE.exec(html)) !== null) tagSequence.push(t[1].toLowerCase());

  const headings: string[] = [];
  HEADING_RE.lastIndex = 0;
  let h: RegExpExecArray | null;
  while ((h = HEADING_RE.exec(html)) !== null) {
    const text = textOf(h[2]);
    if (text) headings.push(text);
  }

  const stylesheets: StylesheetRef[] = [];
  LINK_TAG_RE.lastIndex = 0;
  let l: RegExpExecArray | null;
  while ((l = LINK_TAG_RE.exec(html)) !== null) {
    const a = attrsOf(l[0]);
    const rel = (a.rel ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) continue;
    if (!a.href) continue;
    stylesheets.push({ href: a.href, media: a.media ?? null });
  }

  const seen = new Set<string>();
  const cssReferences: string[] = [];
  CSS_URL_RE.lastIndex = 0;
  let c: RegExpExecArray | null;
  while ((c = CSS_URL_RE.exec(html)) !== null) {
    const name = basename(c[0]);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    cssReferences.push(name);
  }

  return { tagSequence, headings, stylesheets, cssReferences };
}

/**
 * How much two tag sequences overlap, 0..1, as a multiset intersection over
 * the larger sequence. 1 means the same elements in the same quantities (order
 * is deliberately ignored — a reordered document is still the same document
 * for this purpose, and order-sensitive diffing is quadratic).
 *
 * Two empty sequences are 1: identical, trivially. One empty and one not is 0.
 */
export function tagOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const tag of a) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  let shared = 0;
  for (const tag of b) {
    const left = counts.get(tag) ?? 0;
    if (left > 0) {
      shared++;
      counts.set(tag, left - 1);
    }
  }
  return shared / Math.max(a.length, b.length);
}

/** Items in `a` that are not in `b`, preserving order and duplicates. */
function only(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of b) counts.set(item, (counts.get(item) ?? 0) + 1);
  const out: string[] = [];
  for (const item of a) {
    const left = counts.get(item) ?? 0;
    if (left > 0) counts.set(item, left - 1);
    else out.push(item);
  }
  return out;
}

export interface SideInput {
  url: string;
  /** HTML the origin served to a desktop user agent. */
  desktopHtml: string;
  /** HTML the origin served to a phone user agent, same URL. */
  mobileHtml: string;
}

export interface SideReport {
  url: string;
  /** 1 = the origin served a phone the same elements as a desktop. Below 1, it
   *  served something different — the lower it is, the less the two documents
   *  have in common. Read it next to the other side's number. */
  desktopVsMobileTagOverlap: number;
  /** True when the two responses were byte-identical. */
  desktopAndMobileIdentical: boolean;
  /** Headings the desktop document has and the phone document does not. */
  headingsDroppedOnMobile: string[];
  /** Headings the phone document has and the desktop document does not. */
  headingsAddedOnMobile: string[];
  /** Stylesheets the phone document loads, in order. */
  mobileStylesheets: StylesheetRef[];
  mobileHeadings: string[];
  /** Every .css this origin references for a phone. */
  mobileCssReferences: string[];
  /** CSS this origin serves a DESKTOP and not a phone, and vice versa. A
   *  non-empty pair here is device-specific delivery: the origin builds its
   *  mobile page from different stylesheets. Both empty means one stylesheet
   *  set for every device, and any mobile difference is media queries or an
   *  override layer inside those same files. */
  cssOnlyOnDesktop: string[];
  cssOnlyOnMobile: string[];
}

export interface ComparisonReport {
  a: SideReport;
  b: SideReport;
  /** Headings present on a's phone document and absent from b's. */
  headingsOnlyInA: string[];
  headingsOnlyInB: string[];
  /** Overlap of the two phone documents' elements, 0..1. */
  mobileTagOverlap: number;
  /** CSS filenames b's phone document references that a's does not, and vice
   *  versa. Filenames are the only signal here; this asserts nothing about
   *  what the sheets contain. */
  mobileStylesheetsOnlyInA: string[];
  mobileStylesheetsOnlyInB: string[];
  /** Headings that differ, both directions, summed. Zero when the two phone
   *  documents carry the same headings — the number a "make these match" task
   *  can drive down. It counts headings ONLY; it is not a similarity score and
   *  zero here does not mean the pages look alike. */
  headingDifferenceCount: number;
}

function sideReport(side: SideInput): SideReport {
  const desktop = extractStructure(side.desktopHtml);
  const mobile = extractStructure(side.mobileHtml);
  return {
    url: side.url,
    desktopVsMobileTagOverlap: tagOverlap(desktop.tagSequence, mobile.tagSequence),
    desktopAndMobileIdentical: side.desktopHtml === side.mobileHtml,
    headingsDroppedOnMobile: only(desktop.headings, mobile.headings),
    headingsAddedOnMobile: only(mobile.headings, desktop.headings),
    mobileStylesheets: mobile.stylesheets,
    mobileHeadings: mobile.headings,
    mobileCssReferences: mobile.cssReferences,
    cssOnlyOnDesktop: only(desktop.cssReferences, mobile.cssReferences),
    cssOnlyOnMobile: only(mobile.cssReferences, desktop.cssReferences),
  };
}

export function comparePages(a: SideInput, b: SideInput): ComparisonReport {
  const left = sideReport(a);
  const right = sideReport(b);
  const onlyInA = only(left.mobileHeadings, right.mobileHeadings);
  const onlyInB = only(right.mobileHeadings, left.mobileHeadings);
  const aSheets = left.mobileCssReferences;
  const bSheets = right.mobileCssReferences;
  return {
    a: left,
    b: right,
    headingsOnlyInA: onlyInA,
    headingsOnlyInB: onlyInB,
    mobileTagOverlap: tagOverlap(
      extractStructure(a.mobileHtml).tagSequence,
      extractStructure(b.mobileHtml).tagSequence,
    ),
    mobileStylesheetsOnlyInA: only(aSheets, bSheets),
    mobileStylesheetsOnlyInB: only(bSheets, aSheets),
    headingDifferenceCount: onlyInA.length + onlyInB.length,
  };
}
