/**
 * A new deck from an existing one. pptxgenjs cannot open a deck, so "use my
 * company template" was impossible: every create started from a blank theme,
 * and the branded deck a user uploaded could only be text-edited. Here the
 * template's zip is the starting point — its masters, layouts, theme, fonts
 * and media all stay — the slides the caller does not keep are removed, and
 * new slides are minted on the template's own layouts through PLACEHOLDERS,
 * so title and body inherit the layout's position, font and bullet style
 * instead of being drawn with fixed geometry. A deck whose layouts carry no
 * placeholders (pptxgenjs output) gets the same fixed-geometry boxes the
 * image slide uses, so it still reads.
 */
import JSZip from "jszip";
import { deleteSlide, escapeXml, lastSlideLayoutTarget, nextSlideNumber, registerSlide, slideFileNames, slideSize, SLIDE_NS } from "./pptx-edit.js";

export type TemplateLayoutKind = "title" | "section" | "content" | "blank";

export interface TemplateLayout {
  /** Part path, e.g. ppt/slideLayouts/slideLayout2.xml */
  path: string;
  name: string;
  /** The `<p:ph .../>` attribute strings of the layout's placeholders, verbatim. */
  placeholders: string[];
}

export interface TemplateSlide {
  layout?: TemplateLayoutKind;
  title?: string;
  bullets?: string[];
  body?: string;
}

const LAYOUT_RE = /^ppt\/slideLayouts\/slideLayout(\d+)\.xml$/;
const TITLE_TYPES = /\btype="(title|ctrTitle)"/;
const NON_TEXT_TYPES = /\btype="(title|ctrTitle|dt|ftr|sldNum|pic|chart|tbl|media|dgm|clipArt|hdr)"/;

/** The template's layouts in part order, with the placeholders each offers. */
export async function layoutCatalog(zip: JSZip): Promise<TemplateLayout[]> {
  const paths = Object.keys(zip.files).filter((f) => LAYOUT_RE.test(f))
    .sort((a, b) => Number(a.match(LAYOUT_RE)![1]) - Number(b.match(LAYOUT_RE)![1]));
  const out: TemplateLayout[] = [];
  for (const path of paths) {
    const xml = await zip.file(path)!.async("string");
    out.push({
      path,
      name: xml.match(/<p:cSld[^>]*\bname="([^"]*)"/)?.[1] ?? "",
      placeholders: [...xml.matchAll(/<p:ph\b([^>]*?)\/?>/g)].map((m) => m[1].trim()),
    });
  }
  return out;
}

const KIND_NAMES: Record<TemplateLayoutKind, RegExp> = {
  title: /title slide|^title$|cover/i,
  section: /section/i,
  content: /title and content|title, content|content|title only|two content|comparison/i,
  blank: /blank/i,
};

/**
 * The layout for a slide kind: by the layout's own name first (PowerPoint
 * templates name them "Title Slide", "Section Header", "Title and Content"),
 * then by what it offers (a content slide needs a text placeholder), then the
 * layout the template's last slide used, so a deck with one unnamed layout
 * still gets a valid master chain.
 */
export function pickLayout(catalog: TemplateLayout[], kind: TemplateLayoutKind, fallback: string): TemplateLayout {
  const byName = catalog.find((l) => KIND_NAMES[kind].test(l.name));
  if (byName) return byName;
  if (kind === "content" || kind === "section" || kind === "title") {
    const withText = catalog.find((l) => l.placeholders.some((ph) => TITLE_TYPES.test(ph)) && l.placeholders.some((ph) => !NON_TEXT_TYPES.test(ph)));
    if (withText) return withText;
  }
  return catalog.find((l) => l.path === fallback) ?? catalog[0];
}

function paragraphs(lines: string[], bullets: boolean): string {
  return lines.map((line) =>
    `<a:p>${bullets ? "" : "<a:pPr><a:buNone/></a:pPr>"}<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`,
  ).join("");
}

function placeholderShape(id: number, name: string, ph: string, bodyXml: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${bodyXml}</p:txBody></p:sp>`;
}

function fixedShape(id: number, name: string, box: { x: number; y: number; cx: number; cy: number }, bodyXml: string, bullets: boolean): string {
  const bulletStyle = bullets ? `<a:lstStyle><a:lvl1pPr marL="285750" indent="-285750"><a:buChar char="•"/></a:lvl1pPr></a:lstStyle>` : "<a:lstStyle/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr>${bulletStyle}${bodyXml}</p:txBody></p:sp>`;
}

/**
 * Append one text slide on a template layout. With placeholders the shapes
 * carry the layout's `<p:ph>` attributes verbatim and no geometry, so the
 * layout decides where and how the text renders; without them the slide gets
 * a title band and a body box in fixed EMU, like the image slide.
 */
export async function addTemplateSlide(zip: JSZip, layout: TemplateLayout, slide: TemplateSlide): Promise<number> {
  const num = nextSlideNumber(zip);
  const titlePh = layout.placeholders.find((ph) => TITLE_TYPES.test(ph));
  const bodyPh = layout.placeholders.find((ph) => !NON_TEXT_TYPES.test(ph));
  const lines = slide.bullets?.length ? slide.bullets : slide.body ? slide.body.split("\n").filter((l) => l.trim()) : [];
  const bulleted = !!slide.bullets?.length;
  const shapes: string[] = [];
  if (slide.title?.trim()) {
    const titleXml = paragraphs([slide.title.trim()], false);
    if (titlePh) shapes.push(placeholderShape(2, "Title 1", titlePh, titleXml));
    else {
      const { cx, cy } = await slideSize(zip);
      shapes.push(fixedShape(2, "Title 1", { x: Math.round(cx * 0.06), y: Math.round(cy * 0.05), cx: Math.round(cx * 0.88), cy: Math.round(cy * 0.12) },
        `<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr lang="en-US" sz="3200" b="1" dirty="0"/><a:t>${escapeXml(slide.title.trim())}</a:t></a:r></a:p>`, false));
    }
  }
  if (lines.length) {
    const bodyXml = paragraphs(lines, bulleted);
    if (bodyPh) shapes.push(placeholderShape(3, "Content 2", bodyPh, bodyXml));
    else {
      const { cx, cy } = await slideSize(zip);
      shapes.push(fixedShape(3, "Content 2", { x: Math.round(cx * 0.06), y: Math.round(cy * 0.2), cx: Math.round(cx * 0.88), cy: Math.round(cy * 0.7) }, bodyXml, bulleted));
    }
  }
  const slideXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld ${SLIDE_NS}><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes.join("") +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  return registerSlide(zip, num, slideXml, [
    { id: "rId1", type: "slideLayout", target: layout.path.replace(/^ppt\//, "../") },
  ]);
}

export interface FromTemplateResult { kept: number[]; added: number; slides: number; layoutsUsed: string[] }

/**
 * Build a deck from `templateBytes`: keep the template slides in `keep`
 * (1-based, in template order), append `slides` on the template's layouts,
 * and remove every other template slide. New slides are added before the
 * removals so the deck is never empty mid-way, and removals run highest
 * first so positions stay valid. Returns the finished zip.
 */
export async function deckFromTemplate(templateBytes: Buffer, keep: number[], slides: TemplateSlide[]): Promise<{ zip: JSZip; result: FromTemplateResult }> {
  const zip = await JSZip.loadAsync(templateBytes);
  const original = slideFileNames(zip);
  if (original.length === 0) throw new Error("The template has no slides — not a .pptx deck?");
  const keepSet = [...new Set(keep)].sort((a, b) => a - b);
  for (const k of keepSet) {
    if (!Number.isInteger(k) || k < 1 || k > original.length) throw new Error(`keep_slides names slide ${k}, but the template has ${original.length} slide(s)`);
  }
  if (keepSet.length === 0 && slides.length === 0) throw new Error("Nothing to build: keep at least one template slide or give slides to add");

  const catalog = await layoutCatalog(zip);
  if (catalog.length === 0) throw new Error("The template has no slide layouts — deck structure not recognized");
  const fallback = (await lastSlideLayoutTarget(zip)).replace(/^\.\.\//, "ppt/");
  const used = new Set<string>();
  let first = keepSet.length === 0;
  for (const s of slides) {
    const kind: TemplateLayoutKind = s.layout ?? (first ? "title" : "content");
    first = false;
    const layout = pickLayout(catalog, kind, fallback);
    used.add(layout.name || layout.path);
    await addTemplateSlide(zip, layout, s);
  }
  // Remove the template slides not kept, highest position first.
  for (let i = original.length; i >= 1; i--) {
    if (!keepSet.includes(i)) await deleteSlide(zip, i);
  }
  return { zip, result: { kept: keepSet, added: slides.length, slides: slideFileNames(zip).length, layoutsUsed: [...used] } };
}
