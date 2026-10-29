// A project document's searchable text. Reads go through the validated open
// (realpath + no-follow leaf) the file tools use, and each format through the
// same extractor the read tools use, so the index holds what a read shows.
// Text that exists only as pixels, an image or a scanned PDF page, is read by
// OCR on this computer (tools/ocr-tool.ts).

import { extname } from "node:path";
import { PDFParse } from "pdf-parse";
import { readValidatedFile } from "../../security/layer/index.js";
import { extractOfficeText } from "../../tools/office-text.js";
import { htmlToText } from "../../app-renderer/sanitize.js";
import { recognizeText } from "../../tools/ocr-tool.js";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".pptx"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);
/** A PDF page with fewer characters than this is a scan (a page number or a
 *  stamp at most), and is read by OCR instead. */
const SCANNED_PAGE_CHARS = 16;
/** OCR takes seconds a page; past this many scanned pages a PDF is indexed
 *  from its text pages and its first scanned pages only. */
export const MAX_OCR_PAGES = 200;
/** About 240 dpi across a letter-size page: what OCR needs, no more. */
const OCR_PAGE_WIDTH_PX = 2000;

/** About 500K tokens: past it a document is indexed from its start only. */
export const MAX_DOC_TEXT_CHARS = 2_000_000;

export function isDocumentFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || HTML_EXTENSIONS.has(ext) || OFFICE_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext) || ext === ".pdf";
}

/** Each page's text, with every scanned page read by OCR. */
async function pdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const { pages } = await parser.getText();
    const scanned = pages.filter((p) => p.text.replace(/\s/g, "").length < SCANNED_PAGE_CHARS).slice(0, MAX_OCR_PAGES);
    const ocr = new Map<number, string>();
    for (const page of scanned) {
      const shot = await parser.getScreenshot({ partial: [page.num], desiredWidth: OCR_PAGE_WIDTH_PX, imageBuffer: true, imageDataUrl: false });
      const image = shot.pages[0]?.data;
      if (image) ocr.set(page.num, (await recognizeText(Buffer.from(image))).text);
    }
    return pages.map((p) => ocr.get(p.num) || p.text).join("\n\n");
  } finally {
    await parser.destroy();
  }
}

/** The text of the document at `absPath`, or "" when it holds none. Throws on
 *  an unreadable or malformed file; the indexer skips that file. */
export async function documentText(absPath: string): Promise<string> {
  const ext = extname(absPath).toLowerCase();
  const bytes = readValidatedFile(absPath);
  let text: string;
  if (ext === ".pdf") {
    text = await pdfText(bytes);
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    text = (await recognizeText(bytes)).text;
  } else if (OFFICE_EXTENSIONS.has(ext)) {
    text = await extractOfficeText(absPath, bytes);
  } else if (HTML_EXTENSIONS.has(ext)) {
    text = htmlToText(bytes.toString("utf-8"));
  } else {
    text = bytes.toString("utf-8");
  }
  return text.length > MAX_DOC_TEXT_CHARS ? text.slice(0, MAX_DOC_TEXT_CHARS) : text;
}
