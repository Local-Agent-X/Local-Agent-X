/**
 * Plain-text extraction for Office containers (.pptx, .docx) so `read` can
 * open them. Both are zip archives, so the read tool's binary guard used to
 * reject them and point at bash — a dead end for any session without shell
 * access (delegated runs), which then could not review a deck at all.
 */
import { extname } from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { slideFileNames, slideText } from "./shared/pptx-edit.js";

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function isOfficeTextFile(filePath: string, bytes: Buffer): boolean {
  const ext = extname(filePath).toLowerCase();
  if (ext !== ".pptx" && ext !== ".docx") return false;
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

/** One line per paragraph; a run-only join would fuse a slide into one line. */
function paragraphLines(xml: string): string[] {
  return xml.split("</a:p>").map(slideText).map((s) => s.trim()).filter(Boolean);
}

/** The notes part a slide links to, resolved through its rels (not by index). */
async function notesFor(zip: JSZip, slidePath: string): Promise<string[]> {
  const relsPath = slidePath.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
  const rels = await zip.file(relsPath)?.async("string");
  const target = rels?.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)?.[1];
  if (!target) return [];
  const xml = await zip.file(`ppt/notesSlides/${target}`)?.async("string");
  // Notes parts also carry the slide-number placeholder; keep only real prose.
  return xml ? paragraphLines(xml).filter((l) => !/^\d+$/.test(l)) : [];
}

async function pptxText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = slideFileNames(zip);
  const out: string[] = [`[PowerPoint deck — ${slides.length} slide(s), text extracted]`];
  for (const [i, path] of slides.entries()) {
    const xml = (await zip.file(path)!.async("string"));
    const lines = paragraphLines(xml);
    out.push("", `--- Slide ${i + 1} ---`, ...(lines.length ? lines : ["(no text)"]));
    const notes = await notesFor(zip, path);
    if (notes.length) out.push("Speaker notes:", ...notes);
  }
  return out.join("\n");
}

async function docxText(bytes: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  return `[Word document — text extracted]\n\n${value.trim() || "(document is empty)"}`;
}

export async function extractOfficeText(filePath: string, bytes: Buffer): Promise<string> {
  return extname(filePath).toLowerCase() === ".pptx" ? pptxText(bytes) : docxText(bytes);
}
