// Serve-time JS concatenation for the LAX UI pages.
//
// app.html loads ~90 classic <script src="/js/..."> files in order. On a cold
// boot that's ~90 separate file reads + round trips, and on a Defender-heavy
// Windows box each read gets scanned — the bulk of the "page sits blank for
// ~11s" cost. We collapse those into a single /js/_bundle/<page>.js response
// at serve time: the repo HTML stays unbundled (so dev keeps per-file source
// + line numbers), but what the browser receives is one request.
//
// Only classic same-origin /js scripts are bundled. type="module" scripts,
// the importmap, and /vendor scripts keep their own tags — modules execute
// after parsing regardless, so collapsing the classic scripts (which run in
// document order during parse) at the position of the first one preserves
// execution order exactly.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface PageBundle {
  stamp: string;
  body: string;
  rewrittenHtml: string;
}

// Matches a classic same-origin script tag (no type="module") whose src is
// under /js/. The negative lookahead rejects module scripts; /vendor and the
// importmap (no src) never match. Trailing \s* collapses the blank line left
// behind so removed tags don't pile up whitespace.
const CLASSIC_JS_SCRIPT =
  /<script\b(?![^>]*\btype\s*=\s*["']module["'])[^>]*\bsrc\s*=\s*["'](\/js\/[^"']+?)["'][^>]*>\s*<\/script>\s*/gi;

const cache = new Map<string, PageBundle>();

function srcToPath(src: string, publicDir: string): string {
  const clean = src.split("?")[0];
  return join(publicDir, clean);
}

// Returns the bundle for a page, rebuilding only when a listed file's mtime
// (or the HTML's) changed since last call. `rawHtml` lets the HTML route pass
// the bytes it already read; the bundle route omits it and we read the file.
// Returns null when the page declares no bundleable classic /js scripts.
export function getPageBundle(page: string, publicDir: string, rawHtml?: string): PageBundle | null {
  const htmlPath = join(publicDir, `${page}.html`);
  let html: string;
  try { html = rawHtml ?? readFileSync(htmlPath, "utf-8"); }
  catch { return null; }

  const srcs: string[] = [];
  for (const m of html.matchAll(CLASSIC_JS_SCRIPT)) srcs.push(m[1]);
  if (srcs.length === 0) return null;

  const paths = srcs.map(s => srcToPath(s, publicDir));
  let maxMtime = 0;
  try { maxMtime = statSync(htmlPath).mtimeMs; } catch {}
  for (const p of paths) {
    try { maxMtime = Math.max(maxMtime, statSync(p).mtimeMs); } catch {}
  }
  const stamp = String(Math.round(maxMtime));

  const cached = cache.get(page);
  if (cached && cached.stamp === stamp) return cached;

  const parts: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    let code: string;
    try { code = readFileSync(paths[i], "utf-8"); }
    catch { continue; }
    parts.push(`\n//# bundle: ${srcs[i]}\n${code}\n;`);
  }
  const body = parts.join("");

  let swapped = false;
  const rewrittenHtml = html.replace(CLASSIC_JS_SCRIPT, () => {
    if (swapped) return "";
    swapped = true;
    return `<script src="/js/_bundle/${page}.js?v=${stamp}"></script>\n`;
  });

  const built: PageBundle = { stamp, body, rewrittenHtml };
  cache.set(page, built);
  return built;
}
