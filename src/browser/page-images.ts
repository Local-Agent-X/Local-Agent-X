// The browser's `images` action: the page's pictures, so the agent can show one on a
// card (tools/show-card.ts) — a product's photo from the store page it has open, a
// recipe's, a place's. A page snapshot is text and carries no image addresses, and a
// server-side fetch of the page is refused by the sites that matter most (a store
// answered 404, a recipe site 403, 2026-11-05); the agent's own browser has the page.
//
// A fixed, read-only script (run like layout_report's: scanned, then evaluated): the
// page's preview image (og:image / twitter:image) first, then its visible pictures at
// least 80 px on a side, each with its alt text and the link it sits in, deduplicated,
// web addresses only, at most 20. It returns a compact JSON string.

export const PAGE_IMAGES_MAX = 20;

export const PAGE_IMAGES_SCRIPT = `(() => {
  const out = [];
  const seen = new Set();
  const add = (src, alt, href) => {
    if (typeof src !== "string" || !/^https?:\\/\\//i.test(src) || seen.has(src) || out.length >= ${PAGE_IMAGES_MAX}) return;
    seen.add(src);
    const item = { src: src.slice(0, 600), alt: String(alt || "").trim().slice(0, 120) };
    if (href && /^https?:\\/\\//i.test(href)) item.link = String(href).slice(0, 600);
    out.push(item);
  };
  const meta = document.querySelector('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]');
  if (meta) add(new URL(meta.getAttribute("content") || "", location.href).href, document.title, location.href);
  for (const img of Array.from(document.querySelectorAll("img"))) {
    const r = img.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) continue;
    const a = img.closest("a");
    add(img.currentSrc || img.src, img.alt, a ? a.href : "");
  }
  return JSON.stringify(out);
})()`;
