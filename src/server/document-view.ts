/**
 * A document as a readable web page: `?view=html` on a sent file
 * (`/uploads/<f>`, `/files/<path>`) answers with the file rendered as HTML
 * instead of its bytes.
 *
 * The phone opens a document the agent sends by handing it to an installed
 * app. A phone with no app for that type (no Word, no Excel) got only a
 * share sheet, which can send the file on but never show it (2026-11-08: the
 * interview cheat sheet, after Microsoft 365 was removed). The phone now
 * falls back to this page in its own viewer (agentxos-mobile
 * `chat/DocumentReader.tsx`).
 *
 * The page is inert: script-free, served with a CSP that loads nothing but
 * inline styles and data: images, and every value from the document escaped
 * except mammoth's own Word output, which it builds from the document model
 * and escapes itself. A legacy binary format (.doc, .xls, .ppt) has no
 * converter here and answers null.
 */
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import mammoth from "mammoth";
import ExcelJSDefault from "exceljs";
import { PDFParse } from "pdf-parse";
import { escapeHtml } from "../app-renderer/sanitize.js";
import { extractOfficeText } from "../tools/office-text.js";

const ExcelJS = (ExcelJSDefault as unknown as { default: typeof ExcelJSDefault }).default ?? ExcelJSDefault;

/** The CSP the page is served with: nothing runs, nothing loads. */
export const DOCUMENT_VIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** Rows shown per sheet: a phone screen is not a place for a 50,000-row export. */
const MAX_ROWS = 1000;

const STYLE =
  "body{margin:0;padding:16px;font:16px/1.5 -apple-system,Roboto,'Segoe UI',sans-serif;color:#1f2328;background:#fff;word-wrap:break-word}" +
  "h1,h2,h3{line-height:1.25}img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace}" +
  ".sheet{overflow-x:auto;margin-bottom:24px}table{border-collapse:collapse;font-size:14px}td,th{border:1px solid #d0d7de;padding:4px 8px;vertical-align:top}" +
  "th{background:#f6f8fa;text-align:left}.note{color:#656d76;font-size:13px}" +
  "@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}td,th{border-color:#30363d}th{background:#161b22}.note{color:#8d96a0}}";

function page(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`
  );
}

const pre = (text: string): string => `<pre>${escapeHtml(text)}</pre>`;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as { result?: unknown; text?: unknown; richText?: Array<{ text: string }>; hyperlink?: unknown };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (v.result !== undefined) return cellText(v.result);
    if (typeof v.text === "string") return v.text;
    return "";
  }
  return String(value);
}

async function workbookHtml(bytes: Buffer, csv: boolean): Promise<string> {
  const wb = new ExcelJS.Workbook();
  if (csv) await wb.csv.read(Readable.from(bytes));
  else await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const parts: string[] = [];
  wb.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, n) => {
      if (n > MAX_ROWS) return;
      const cells = (row.values as unknown[]).slice(1).map((v) => escapeHtml(cellText(v)));
      const tag = n === 1 ? "th" : "td";
      rows.push(`<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`);
    });
    const more = sheet.rowCount > MAX_ROWS ? `<p class="note">Showing the first ${MAX_ROWS} of ${sheet.rowCount} rows.</p>` : "";
    const heading = csv ? "" : `<h2>${escapeHtml(sheet.name)}</h2>`;
    parts.push(`<div class="sheet">${heading}<table>${rows.join("")}</table>${more}</div>`);
  });
  return parts.join("") || `<p class="note">This workbook has no rows.</p>`;
}

async function pdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  const { text } = await parser.getText();
  return `<p class="note">Text of the PDF; layout and pictures are not shown.</p>${pre(text)}`;
}

/** Answer a `?view=html` request for `file` (already authorized and confined
 *  by the caller): the page, 415 for a type with no converter, 422 for a file
 *  that would not convert. Never throws. */
export async function serveDocumentView(file: string, res: ServerResponse): Promise<void> {
  const name = basename(file);
  let html: string | null;
  try {
    html = await documentViewHtml(name, readFileSync(file));
  } catch (e) {
    res.writeHead(422, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Could not read ${name} as a document: ${(e as Error).message}` }));
    return;
  }
  if (html === null) {
    res.writeHead(415, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `There is no readable view for ${extname(name) || "this"} files.` }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": DOCUMENT_VIEW_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

/** `bytes` (named `name`) as a standalone, inert HTML page, or null when its
 *  type has no converter here. Throws when the file is not what its name says. */
export async function documentViewHtml(name: string, bytes: Buffer): Promise<string | null> {
  const ext = extname(name).slice(1).toLowerCase();
  let body: string;
  switch (ext) {
    case "docx": body = (await mammoth.convertToHtml({ buffer: bytes })).value; break;
    case "pptx": body = pre(await extractOfficeText(name, bytes)); break;
    case "xlsx": body = await workbookHtml(bytes, false); break;
    case "csv": body = await workbookHtml(bytes, true); break;
    case "pdf": body = await pdfText(bytes); break;
    case "txt": case "md": case "json": case "rtf": body = pre(bytes.toString("utf-8")); break;
    default: return null;
  }
  return page(name, body);
}
