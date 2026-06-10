/**
 * Self-check / preview for generated documents. Two layers:
 *   1. Structural check (ALWAYS, all formats, no external deps) — re-open the
 *      file, extract text/structure, flag problems (empty, leaked markup).
 *   2. Visual thumbnail — a real page-1 PNG. PDFs render directly (pdfjs +
 *      @napi-rs/canvas, cross-platform, bundled). Word/PPT/Excel render via a
 *      DETECTED LibreOffice (soffice → PDF → PNG); absent → structural only.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readValidatedFile } from "../../security/validated-io.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const pexec = promisify(execFile);

export type DocKind = "docx" | "pdf" | "xlsx" | "pptx" | "unknown";

export interface StructureReport {
  kind: DocKind;
  summary: string;        // human one-liner: counts
  textPreview: string;    // first chunk of extracted text
  flags: string[];        // problems found (empty, leaked-markup, ...)
}

export function docKind(filePath: string): DocKind {
  const e = extname(filePath).toLowerCase();
  return e === ".docx" ? "docx" : e === ".pdf" ? "pdf" : e === ".xlsx" ? "xlsx" : e === ".pptx" ? "pptx" : "unknown";
}

// Markup that should NEVER appear in finished output (our sanitizer strips it);
// finding it here is a regression signal worth surfacing.
const LEAK_RE = /<\/?(?:div|span|p|br|table|td|tr)\b|&nbsp;|&amp;|[​-‍﻿]/i;

function flagsFor(text: string): string[] {
  const flags: string[] = [];
  if (!text.trim()) flags.push("empty: no extractable text");
  if (LEAK_RE.test(text)) flags.push("leaked-markup: HTML/entities/zero-width found in output");
  return flags;
}

const clip = (s: string, n = 600): string => (s.length > n ? s.slice(0, n) + "…" : s);

/** Extract a structural report by re-opening the generated file. */
export async function extractStructure(filePath: string, kind: DocKind): Promise<StructureReport> {
  const buf = readValidatedFile(filePath);
  if (kind === "docx") {
    const mammoth = (await import("mammoth")).default;
    const { value } = await mammoth.extractRawText({ buffer: buf });
    const paras = value.split("\n").filter((l) => l.trim()).length;
    return { kind, summary: `${paras} paragraph(s), ${value.length} chars`, textPreview: clip(value.trim()), flags: flagsFor(value) };
  }
  if (kind === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const info = await parser.getInfo();
    const { text } = await parser.getText();
    await parser.destroy();
    return { kind, summary: `${info.total} page(s), ${text.length} chars`, textPreview: clip(text.trim()), flags: flagsFor(text) };
  }
  if (kind === "xlsx") {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    const rows = ws?.rowCount ?? 0, cols = ws?.columnCount ?? 0;
    const preview: string[] = [];
    ws?.eachRow((row, n) => { if (n <= 5) preview.push((row.values as unknown[]).slice(1).map((v) => String(v ?? "")).join(" | ")); });
    const text = preview.join("\n");
    return { kind, summary: `${wb.worksheets.length} sheet(s), first sheet ${rows}×${cols}`, textPreview: clip(text), flags: flagsFor(text) };
  }
  if (kind === "pptx") {
    const JSZip = (await import("jszip")).default;
    // One pptx parser in the repo: pptx-edit.ts owns slide enumeration +
    // run extraction (entity-decoded); this preview is just a consumer.
    const { slideFileNames, slideText } = await import("./pptx-edit.js");
    const zip = await JSZip.loadAsync(buf);
    const slideFiles = slideFileNames(zip);
    const texts: string[] = [];
    for (const f of slideFiles) {
      const t = slideText(await zip.file(f)!.async("string"));
      if (t) texts.push(t);
    }
    const text = texts.join("\n");
    return { kind, summary: `${slideFiles.length} slide(s)`, textPreview: clip(text), flags: flagsFor(text) };
  }
  return { kind, summary: "unknown format", textPreview: "", flags: ["unsupported format"] };
}

// ── Visual thumbnail ────────────────────────────────────────────────────────

const SOFFICE_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/LibreOffice.app/Contents/MacOS/soffice"],
  win32: ["C:/Program Files/LibreOffice/program/soffice.exe", "C:/Program Files (x86)/LibreOffice/program/soffice.exe"],
  linux: ["/usr/bin/soffice", "/usr/bin/libreoffice", "/opt/libreoffice/program/soffice", "/snap/bin/libreoffice"],
};

/** Locate LibreOffice: env override, then platform defaults. null = absent. */
export function findSoffice(): string | null {
  const env = process.env.LAX_SOFFICE_PATH;
  if (env && existsSync(env)) return env;
  for (const p of SOFFICE_PATHS[process.platform] ?? []) if (existsSync(p)) return p;
  return null;
}

/** Convert an Office file to PDF bytes via LibreOffice, or null if unavailable. */
async function officeToPdf(filePath: string): Promise<Buffer | null> {
  const soffice = findSoffice();
  if (!soffice) return null;
  const work = await mkdtemp(join(tmpdir(), "lax-soffice-"));
  try {
    // Isolated UserInstallation avoids the "soffice already running" lock when
    // the user has LibreOffice open.
    await pexec(soffice, [
      "--headless", "--norestore", "--nolockcheck",
      `-env:UserInstallation=file://${work}/profile`,
      "--convert-to", "pdf", "--outdir", work, filePath,
    ], { timeout: 60_000 });
    const pdf = join(work, basename(filePath).replace(/\.[^.]+$/, ".pdf"));
    return existsSync(pdf) ? await readFile(pdf) : null;
  } catch {
    return null;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Render PDF page 1 to a PNG buffer (pdfjs + @napi-rs/canvas). */
async function pdfPageToPng(pdfBuf: Buffer, targetW = 1000): Promise<Buffer> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf), useSystemFonts: true, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2, Math.max(0.5, targetW / base.width)) });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as any, viewport, canvas: canvas as any }).promise;
  await doc.destroy();
  return canvas.toBuffer("image/png");
}

export interface ThumbnailResult { ok: boolean; outPath?: string; reason?: string }

/** Render a page-1 PNG thumbnail to `outPath`. PDFs render directly; Office
 *  files need LibreOffice (degrades gracefully when absent). */
export async function renderThumbnail(filePath: string, kind: DocKind, outPath: string): Promise<ThumbnailResult> {
  try {
    let pdf: Buffer | null;
    if (kind === "pdf") pdf = readValidatedFile(filePath);
    else if (kind === "docx" || kind === "pptx" || kind === "xlsx") {
      pdf = await officeToPdf(filePath);
      if (!pdf) return { ok: false, reason: "visual thumbnail needs LibreOffice (not found). Set LAX_SOFFICE_PATH to enable Office previews." };
    } else return { ok: false, reason: "unsupported format" };
    const png = await pdfPageToPng(pdf);
    await writeFile(outPath, png);
    return { ok: true, outPath };
  } catch (e) {
    return { ok: false, reason: `thumbnail render failed: ${(e as Error).message}` };
  }
}
