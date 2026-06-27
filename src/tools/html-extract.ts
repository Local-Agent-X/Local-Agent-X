/**
 * Extract the readable, structured content from an HTML page so `web_fetch`
 * returns something a model can use instead of 50K chars of raw obfuscated
 * markup + JS. Regex-based on purpose (the repo carries no HTML-parser dep, and
 * the job — title, meta, JSON-LD, visible text — doesn't need a full DOM).
 *
 * `looksEmpty` flags a JS-rendered shell: a page whose real content is loaded
 * client-side and therefore ISN'T in the static HTML at all. No extractor can
 * conjure what isn't there, so the caller surfaces a route-around hint
 * (sitemap / feed / browser) instead of returning a near-blank.
 */

export interface ExtractedHtml {
  content: string;
  looksEmpty: boolean;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)));
}

function safeCodePoint(n: number): string {
  try { return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""; } catch { return ""; }
}

/** Pull the `content="..."` of the first <meta> tag carrying attr="value",
 *  order-independent (real pages put content before or after property/name). */
function metaContent(html: string, attr: string, value: string): string {
  const tag = new RegExp(`<meta\\b[^>]*\\b${attr}=["']${value}["'][^>]*>`, "i").exec(html)?.[0];
  if (!tag) return "";
  const c = /\bcontent=["']([^"']*)["']/i.exec(tag);
  return c ? decodeEntities(c[1]).trim() : "";
}

export function extractFromHtml(html: string): ExtractedHtml {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = (titleTag ? decodeEntities(titleTag[1]).trim() : "") || metaContent(html, "property", "og:title");
  const description = metaContent(html, "name", "description") || metaContent(html, "property", "og:description");

  // schema.org JSON-LD — the structured gold (Article headline, Product+Offer
  // price, Recipe, Event…). Kept raw; it's already machine-readable.
  const jsonLd: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim();
    if (raw) jsonLd.push(raw.length > 4000 ? `${raw.slice(0, 4000)} …[truncated]` : raw);
  }

  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();

  // A JS shell: a SUBSTANTIAL page that boiled down to almost no readable text
  // and carried no structured data — i.e. the content is rendered client-side.
  // The `html.length` guard avoids false-flagging a genuinely short static page
  // (example.com is ~560 bytes of real content) as an empty shell.
  const looksEmpty = jsonLd.length === 0 && text.length < 200 && html.length > 2_000;

  const parts: string[] = [];
  if (title) parts.push(`# ${title}`);
  if (description) parts.push(description);
  if (jsonLd.length) parts.push(`<structured-data type="json-ld">\n${jsonLd.join("\n---\n")}\n</structured-data>`);
  if (text) parts.push(text);

  return { content: parts.join("\n\n"), looksEmpty };
}
