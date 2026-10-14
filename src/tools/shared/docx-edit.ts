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
 * Two passes per part. A match inside one run is replaced in that run alone,
 * so even the run's own formatting survives. Word routinely splits a
 * placeholder across runs ("{{" | "name" | "}}", a spell-check or formatting
 * boundary), so a match that only exists across a paragraph's joined runs is
 * replaced by writing the joined, updated text into the paragraph's first run
 * and emptying the rest — that paragraph's inline formatting flattens to its
 * first run; the paragraph style, and the rest of the document, are untouched.
 */
import JSZip from "jszip";
import { escapeXml, unescapeXml } from "./pptx-edit.js";

// Every part that carries body text: the document, headers/footers, notes.
const TEXT_PART_RE = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const RUN_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
// `</w:pPr>` does not end in `</w:p>`, so the lazy match stops at the paragraph.
const PARA_RE = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

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

function applyAll(text: string, pairs: DocxReplacement[]): { text: string; hits: number } {
  let hits = 0;
  for (const { find, replace } of pairs) {
    const parts = text.split(find);
    if (parts.length === 1) continue;
    hits += parts.length - 1;
    text = parts.join(replace);
  }
  return { text, hits };
}

function replaceInRuns(xml: string, pairs: DocxReplacement[]): { xml: string; hits: number } {
  let hits = 0;
  const next = xml.replace(RUN_RE, (run, raw: string) => {
    const r = applyAll(unescapeXml(raw), pairs);
    if (r.hits === 0) return run;
    hits += r.hits;
    return textRun(r.text);
  });
  return { xml: next, hits };
}

function replaceAcrossRuns(xml: string, pairs: DocxReplacement[]): { xml: string; hits: number; merged: number } {
  let hits = 0;
  let merged = 0;
  const next = xml.replace(PARA_RE, (para) => {
    const runs = [...para.matchAll(RUN_RE)];
    if (runs.length < 2) return para;
    const r = applyAll(runs.map((m) => unescapeXml(m[1])).join(""), pairs);
    if (r.hits === 0) return para;
    hits += r.hits;
    merged++;
    let first = true;
    return para.replace(RUN_RE, () => {
      if (!first) return textRun("");
      first = false;
      return textRun(r.text);
    });
  });
  return { xml: next, hits, merged };
}

/** Find/replace over every text-bearing part. Matching is case-sensitive exact
 *  substring; an empty `find` is ignored. Markup is never matched, so a find
 *  string that happens to look like a tag cannot corrupt the document. */
export async function replaceTextInDocx(zip: JSZip, replacements: DocxReplacement[]): Promise<DocxReplaceResult> {
  const pairs = replacements.filter((p) => p.find.length > 0);
  const result: DocxReplaceResult = { replacements: 0, mergedParagraphs: 0 };
  if (pairs.length === 0) return result;
  for (const name of docxTextPartNames(zip)) {
    const original = await zip.file(name)!.async("string");
    const single = replaceInRuns(original, pairs);
    const spanning = replaceAcrossRuns(single.xml, pairs);
    const hits = single.hits + spanning.hits;
    if (hits === 0) continue;
    zip.file(name, spanning.xml);
    result.replacements += hits;
    result.mergedParagraphs += spanning.merged;
  }
  return result;
}

export function packDocx(zip: JSZip): Promise<Buffer> {
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
