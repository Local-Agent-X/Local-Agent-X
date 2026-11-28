/**
 * In-place .docx text replacement via direct OOXML manipulation (jszip) —
 * the Word counterpart of pptx-edit.ts.
 *
 * The docx library is write-only, so before this module `document edit` and
 * `document template` extracted the text with mammoth and rebuilt a fresh
 * document from it: every style, image, table, header and footer of the
 * original was lost, while the descriptions promised an edit and a template
 * fill. Editing the text runs inside the zip keeps everything else intact.
 *
 * One pass per part, a paragraph at a time. Where every match sits inside one
 * run, each run is replaced on its own, so even the run's formatting survives.
 * Word routinely splits a placeholder across runs ("{{" | "name" | "}}", a
 * spell-check or formatting boundary), so where a match only exists across the
 * paragraph's joined runs, the joined, updated text is written into the
 * paragraph's first run and the rest emptied — that paragraph's inline
 * formatting flattens to its first run; the paragraph style, and the rest of
 * the document, are untouched.
 *
 * Text is replaced once. Each run and each paragraph is read as it was in the
 * file, and what a replacement writes is never searched again: not by a second
 * pass (replacing "Acme" with "Acme Corp" used to give "Acme Corp Corp" in any
 * paragraph of two runs or more) and not by another pair (a template value
 * that contains another key's marker is a value, not a template).
 */
import JSZip from "jszip";
import { escapeXml, unescapeXml } from "./pptx-edit.js";

// Every part that carries body text: the document, headers/footers, notes.
const TEXT_PART_RE = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const RUN_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
// A paragraph, or a text run that is in none (the part of a paragraph after a
// text box, whose own paragraph ended the lazy match). `</w:pPr>` does not end
// in `</w:p>`, so the lazy match stops at the paragraph.
const UNIT_RE = /(<w:p\b[^>]*>[\s\S]*?<\/w:p>)|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;

export interface DocxReplacement { find: string; replace: string }
export interface DocxReplaceResult {
  replacements: number;
  /** Paragraphs whose runs were merged because a match spanned several. */
  mergedParagraphs: number;
}

export function docxTextPartNames(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((f) => TEXT_PART_RE.test(f)).sort();
}

function textRun(text: string): string {
  return `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`;
}

/**
 * Every pair applied to `text` in one left-to-right pass. `pairs` is ordered
 * longest find first, so where two finds start at the same place the longer
 * one wins. What a pair writes is not searched.
 */
function applyAll(text: string, pairs: DocxReplacement[]): { text: string; hits: number } {
  let out = "";
  let hits = 0;
  let copied = 0;
  for (let i = 0; i < text.length;) {
    const pair = pairs.find((p) => text.startsWith(p.find, i));
    if (!pair) { i++; continue; }
    out += text.slice(copied, i) + pair.replace;
    i += pair.find.length;
    copied = i;
    hits++;
  }
  return hits === 0 ? { text, hits } : { text: out + text.slice(copied), hits };
}

function replaceInParagraph(para: string, pairs: DocxReplacement[]): { xml: string; hits: number; merged: boolean } {
  const texts = [...para.matchAll(RUN_RE)].map((m) => unescapeXml(m[1]));
  const whole = applyAll(texts.join(""), pairs);
  if (whole.hits === 0) return { xml: para, hits: 0, merged: false };
  const each = texts.map((t) => applyAll(t, pairs));
  let run = 0;
  if (each.map((r) => r.text).join("") === whole.text) {
    // Every match is inside one run: each run keeps its own formatting.
    const xml = para.replace(RUN_RE, (unchanged) => {
      const r = each[run++];
      return r.hits === 0 ? unchanged : textRun(r.text);
    });
    return { xml, hits: whole.hits, merged: false };
  }
  const xml = para.replace(RUN_RE, () => textRun(run++ === 0 ? whole.text : ""));
  return { xml, hits: whole.hits, merged: true };
}

function replaceInPart(xml: string, pairs: DocxReplacement[]): { xml: string; hits: number; merged: number } {
  let hits = 0;
  let merged = 0;
  const next = xml.replace(UNIT_RE, (unit: string, para: string | undefined, runText: string | undefined) => {
    if (para !== undefined) {
      const r = replaceInParagraph(para, pairs);
      hits += r.hits;
      if (r.merged) merged++;
      return r.xml;
    }
    const r = applyAll(unescapeXml(runText ?? ""), pairs);
    hits += r.hits;
    return r.hits === 0 ? unit : textRun(r.text);
  });
  return { xml: next, hits, merged };
}

/** Find/replace over every text-bearing part. Matching is case-sensitive exact
 *  substring; an empty `find` is ignored, and of two pairs with the same `find`
 *  the first is used. Markup is never matched, so a find string that happens
 *  to look like a tag cannot corrupt the document. */
export async function replaceTextInDocx(zip: JSZip, replacements: DocxReplacement[]): Promise<DocxReplaceResult> {
  // Longest find first (the sort is stable, so equal lengths keep their order).
  const pairs = replacements.filter((p) => p.find.length > 0).sort((a, b) => b.find.length - a.find.length);
  const result: DocxReplaceResult = { replacements: 0, mergedParagraphs: 0 };
  if (pairs.length === 0) return result;
  for (const name of docxTextPartNames(zip)) {
    const original = await zip.file(name)!.async("string");
    const part = replaceInPart(original, pairs);
    if (part.hits === 0) continue;
    zip.file(name, part.xml);
    result.replacements += part.hits;
    result.mergedParagraphs += part.merged;
  }
  return result;
}

export function packDocx(zip: JSZip): Promise<Buffer> {
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
