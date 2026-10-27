// A project document's searchable text. Reads go through the validated open
// (realpath + no-follow leaf) the file tools use, and each format through the
// same extractor the read tools use, so the index holds what a read shows.

import { extname } from "node:path";
import { PDFParse } from "pdf-parse";
import { readValidatedFile } from "../../security/layer/index.js";
import { extractOfficeText } from "../../tools/office-text.js";
import { htmlToText } from "../../app-renderer/sanitize.js";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".pptx"]);

/** About 500K tokens: past it a document is indexed from its start only. */
export const MAX_DOC_TEXT_CHARS = 2_000_000;

export function isDocumentFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || HTML_EXTENSIONS.has(ext) || OFFICE_EXTENSIONS.has(ext) || ext === ".pdf";
}

/** The text of the document at `absPath`, or "" when it holds none. Throws on
 *  an unreadable or malformed file; the indexer skips that file. */
export async function documentText(absPath: string): Promise<string> {
  const ext = extname(absPath).toLowerCase();
  const bytes = readValidatedFile(absPath);
  let text: string;
  if (ext === ".pdf") {
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try { text = (await parser.getText()).text ?? ""; } finally { await parser.destroy(); }
  } else if (OFFICE_EXTENSIONS.has(ext)) {
    text = await extractOfficeText(absPath, bytes);
  } else if (HTML_EXTENSIONS.has(ext)) {
    text = htmlToText(bytes.toString("utf-8"));
  } else {
    text = bytes.toString("utf-8");
  }
  return text.length > MAX_DOC_TEXT_CHARS ? text.slice(0, MAX_DOC_TEXT_CHARS) : text;
}
