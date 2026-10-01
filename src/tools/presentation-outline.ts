// The markdown outline the from_outline and from_template actions share:
// "# title" starts a slide, "## title" a section divider, "- item" a bullet,
// anything else body text. Flat input is normalized onto lines first.
import type { SlideSpec } from "./shared/pptx-render.js";

/** Pre-process outline text so flat/unformatted input still parses.
 *  Ensures # headings and - bullets each start on their own line. */
function normalizeOutline(raw: string): string {
  if (/^#+\s/m.test(raw)) return raw;   // already markdown
  return raw
    .replace(/\s+(#{1,3}\s)/g, "\n$1")
    .replace(/\s+[-*]\s+/g, "\n- ")
    .replace(/([.!?])\s+([A-Z])/g, "$1\n$2");
}

export function outlineToSlides(md: string): SlideSpec[] {
  const slides: SlideSpec[] = [];
  let cur: SlideSpec | null = null;
  let first = true;
  for (const raw of normalizeOutline(md).split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) {
      if (cur) slides.push(cur);
      cur = { title: line.slice(2).trim(), layout: first ? "title" : "content" };
      first = false;
    } else if (line.startsWith("## ")) {
      if (cur) slides.push(cur);
      cur = { title: line.slice(3).trim(), layout: "section" };
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!cur) cur = { layout: "content" };
      (cur.bullets ??= []).push(line.replace(/^\s*[-*]\s+/, ""));
    } else if (line.trim()) {
      if (!cur) cur = { layout: "content" };
      cur.body = cur.body ? `${cur.body}\n${line.trim()}` : line.trim();
    }
  }
  if (cur) slides.push(cur);
  return slides;
}
