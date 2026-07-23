import type { Download, Page, Response } from "playwright";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { getRuntimeConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { getBrowserInspectionDir, getBrowserNativeDownloadDir, isInsideDirectory } from "./download-paths.js";
import { publishVerifiedDownload } from "./download-integrity.js";
import { inspectZipFile, type ZipInspection } from "./download-zip.js";

const browserLogger = createLogger("browser.downloads");
export const MAX_BROWSER_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export type DownloadStatus = "released" | "quarantined" | "rejected" | "failed";
export interface DownloadRecord {
  id: string;
  sessionId: string;
  sourceUrl: string;
  pageUrl: string;
  filename: string;
  size: number;
  digest: string;
  contentType: string;
  detectedType: string;
  status: DownloadStatus;
  reason: string;
  ts: number;
  releasePath?: string;
  quarantinePath?: string;
  metadataPath?: string;
}

interface InspectInput {
  sessionId: string;
  sourceUrl: string;
  pageUrl: string;
  suggestedFilename: string;
  contentType?: string;
  stream: Readable;
  quarantineDir?: string;
  releaseDir?: string;
  maxBytes?: number;
}

const records: DownloadRecord[] = [];
const installedPages = new WeakSet<Page>();

function privateUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.startsWith("blob:") ? "blob:[redacted]" : "[unavailable]";
  }
}

function sourceOrigin(raw: string): string {
  try { return new URL(raw).origin; } catch { return "[unavailable]"; }
}

function recordFailure(sessionId: string, sourceUrl: string, pageUrl: string, suggestedFilename: string, reason: string): DownloadRecord {
  const record: DownloadRecord = {
    id: `dl-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    sessionId,
    sourceUrl: privateUrl(sourceUrl),
    pageUrl: privateUrl(pageUrl),
    filename: safeDownloadFilename(suggestedFilename),
    size: 0,
    digest: "",
    contentType: "",
    detectedType: "unknown",
    status: "failed",
    reason,
    ts: Date.now(),
  };
  records.push(record);
  if (records.length > 50) records.shift();
  return record;
}

export function safeDownloadFilename(suggested: string): string {
  const original = basename(suggested);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.: ]|$)/i.test(original);
  let safe = original.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
  if (!safe || safe === "." || safe === "..") safe = "download.bin";
  if (reserved || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  if (safe.length > 120) {
    const ext = extname(safe).slice(0, 20);
    safe = `${safe.slice(0, 120 - ext.length)}${ext}`;
  }
  return safe;
}

function detectType(head: Buffer): string {
  if (head.subarray(0, 2).equals(Buffer.from("MZ")) || head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return "executable";
  if (head.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(head.readUInt32BE(0))) return "executable";
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "zip";
  if (head.subarray(0, 5).toString() === "%PDF-") return "pdf";
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpeg";
  if (/^GIF8[79]a/.test(head.subarray(0, 6).toString("ascii"))) return "gif";
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  const text = head.toString("utf8").trimStart().toLowerCase();
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) return "html";
  if (!head.includes(0) && !head.toString("utf8").includes("\ufffd")) return "text";
  return "binary";
}

const TYPE_EXTENSIONS: Record<string, Set<string>> = {
  pdf: new Set([".pdf"]), png: new Set([".png"]), jpeg: new Set([".jpg", ".jpeg"]),
  gif: new Set([".gif"]), webp: new Set([".webp"]), html: new Set([".html", ".htm"]),
  text: new Set([".txt", ".csv", ".json", ".xml", ".md", ".log"]),
  zip: new Set([".zip", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"]),
};

const MIME_TYPES: Record<string, Set<string>> = {
  pdf: new Set(["application/pdf"]), png: new Set(["image/png"]), jpeg: new Set(["image/jpeg"]),
  gif: new Set(["image/gif"]), webp: new Set(["image/webp"]), html: new Set(["text/html"]),
  text: new Set(["text/plain", "text/csv", "application/json", "application/xml", "text/xml", "text/markdown"]),
  zip: new Set(["application/zip", "application/x-zip-compressed", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet", "application/vnd.oasis.opendocument.presentation"]),
};

function policy(filename: string, declared: string, detected: string, zip: ZipInspection | null, zipError?: string): { status: DownloadStatus; reason: string } {
  const ext = extname(filename).toLowerCase();
  if (detected === "executable" || [".exe", ".msi", ".dll", ".com", ".scr", ".bat", ".cmd", ".ps1", ".sh", ".js", ".vbs", ".jar"].includes(ext)) {
    return { status: "rejected", reason: "Executable or script downloads are blocked." };
  }
  if (detected === "zip" && zipError) return { status: "rejected", reason: zipError };
  const macroExtension = [".docm", ".xlsm", ".pptm", ".xlam"].includes(ext);
  if (macroExtension && detected !== "zip") {
    return { status: "rejected", reason: "Macro-document extension does not match the file signature." };
  }
  if (zip?.macroEnabled || macroExtension) {
    return { status: "quarantined", reason: "Macro-enabled documents require explicit approval before release." };
  }
  if (!TYPE_EXTENSIONS[detected]?.has(ext)) {
    return { status: "rejected", reason: `File extension does not match detected ${detected} content.` };
  }
  const mime = declared.split(";", 1)[0].trim().toLowerCase();
  if (mime && mime !== "application/octet-stream" && !MIME_TYPES[detected]?.has(mime)) {
    return { status: "rejected", reason: `Declared content type does not match detected ${detected} content.` };
  }
  if (detected === "html") {
    return { status: "quarantined", reason: "Active HTML or script content requires explicit approval before release." };
  }
  if (detected === "zip" && [".odt", ".ods", ".odp"].includes(ext)) {
    return { status: "quarantined", reason: "OpenDocument archives require explicit approval before release." };
  }
  if (detected === "zip" && ext === ".zip") {
    return { status: "quarantined", reason: "Archive downloads require explicit approval before release." };
  }
  return { status: "released", reason: "Passed filename, size, content type, and signature checks." };
}

export async function inspectBrowserDownload(input: InspectInput): Promise<DownloadRecord> {
  const filename = safeDownloadFilename(input.suggestedFilename);
  const quarantineDir = resolve(input.quarantineDir ?? getBrowserInspectionDir());
  const releaseDir = resolve(input.releaseDir ?? join(getRuntimeConfig().workspace, "downloads"));
  mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  const id = `dl-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const quarantinePath = join(quarantineDir, `${id}.quarantine`);
  const metadataPath = join(quarantineDir, `${id}.json`);
  const out = createWriteStream(quarantinePath, { flags: "wx", mode: 0o600 });
  let size = 0;
  let head = Buffer.alloc(0);
  const hash = createHash("sha256");
  try {
    for await (const raw of input.stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      const maxBytes = input.maxBytes ?? MAX_BROWSER_DOWNLOAD_BYTES;
      if (size > maxBytes) throw new Error(`Download exceeds the ${maxBytes} byte size cap.`);
      if (head.length < 512) head = Buffer.concat([head, chunk]).subarray(0, 512);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((resolveWrite) => out.once("drain", resolveWrite));
    }
    await new Promise<void>((resolveEnd, rejectEnd) => {
      out.once("finish", resolveEnd);
      out.once("error", rejectEnd);
      out.end();
    });
    const detectedType = detectType(head);
    let zip: ZipInspection | null = null;
    let zipError: string | undefined;
    if (detectedType === "zip") {
      try { zip = await inspectZipFile(quarantinePath, filename); }
      catch (error) { zipError = (error as Error).message; }
    }
    const verdict = policy(filename, input.contentType ?? "", detectedType, zip, zipError);
    const record: DownloadRecord = {
      id, sessionId: input.sessionId, sourceUrl: privateUrl(input.sourceUrl), pageUrl: privateUrl(input.pageUrl),
      filename, size, digest: hash.digest("hex"), contentType: (input.contentType ?? "").split(";", 1)[0], detectedType,
      status: verdict.status, reason: verdict.reason, ts: Date.now(), quarantinePath, metadataPath,
    };
    await writeFile(metadataPath, JSON.stringify({ ...record, quarantinePath: "retained" }, null, 2), { mode: 0o600 });
    if (verdict.status === "rejected") {
      await rm(quarantinePath, { force: true });
      delete record.quarantinePath;
    } else if (verdict.status === "released") {
      mkdirSync(releaseDir, { recursive: true, mode: 0o700 });
      record.releasePath = await publishVerifiedDownload(quarantinePath, releaseDir, filename, record);
      delete record.quarantinePath;
    }
    await writeFile(metadataPath, JSON.stringify({ ...record, quarantinePath: record.quarantinePath ? "retained" : undefined }, null, 2), { mode: 0o600 });
    records.push(record);
    if (records.length > 50) records.shift();
    return record;
  } catch (error) {
    if (!out.closed) {
      await new Promise<void>((resolveClose) => {
        out.once("close", resolveClose);
        out.destroy();
      });
    }
    await rm(quarantinePath, { force: true });
    await rm(metadataPath, { force: true });
    throw error;
  }
}

// ── In-app (Electron) download ingest ─────────
// The desktop's per-partition will-download handler (desktop/src/
// browser-partition.ts) saves every AGENT-attributed download to
// <LAX_DIR>/quarantine/<id>.part (a positively USER-attributed download is
// the user's own browsing and lands in ~/Downloads, never reaching this seam)
// and pushes terminal entries over the bridge (browser-downloads-bridge.ts →
// bridge-perception.handleBrowserDownloadEvent → here). This seam runs the
// SAME inspection pipeline (inspectBrowserDownload: size cap + sha256 + magic
// detection + policy + quarantine/release) over those bytes, producing a
// normal DownloadRecord so formatRecentDownloads / approval / release work
// identically for both backends — one policy implementation, never two.
export interface InAppDownloadEntry {
  id: string;
  url: string;
  pageUrl: string;
  filename: string;
  mime: string;
  bytes: number;
  state: string;
  savePath: string;
}

// Idempotency law: an entry ingested once is never double-recorded. Dedupe is
// SERVER-side (not a desktop-only flag) because the desktop's outbox is
// at-least-once — a resend after a send the desktop couldn't confirm must be
// dropped HERE. The id is claimed before any async work so a concurrent
// re-push during hashing can't double-record either.
const ingestedInAppIds = new Set<string>();

export async function ingestInAppDownload(
  sessionId: string,
  entry: InAppDownloadEntry,
  dirs?: { quarantineDir?: string; releaseDir?: string },
): Promise<DownloadRecord | null> {
  if (ingestedInAppIds.has(entry.id)) return null;
  ingestedInAppIds.add(entry.id);
  try {
    if (entry.state !== "completed") {
      return recordFailure(sessionId, entry.url, entry.pageUrl, entry.filename,
        `Browser reported the download ${entry.state}; partial bytes were removed.`);
    }
    const record = await inspectBrowserDownload({
      sessionId, sourceUrl: entry.url, pageUrl: entry.pageUrl,
      suggestedFilename: entry.filename, contentType: entry.mime,
      stream: createReadStream(entry.savePath), ...dirs,
    });
    browserLogger.info(`[downloads] ${record.status} ${record.filename} from ${sourceOrigin(entry.url)} (in-app)`);
    return record;
  } catch (error) {
    browserLogger.warn(`[downloads] in-app ingest failed from ${sourceOrigin(entry.url)}: ${(error as Error).message}`);
    return recordFailure(sessionId, entry.url, entry.pageUrl, entry.filename,
      `Download failed and partial bytes were removed: ${(error as Error).message}`);
  } finally {
    // The desktop .part is consumed either way: released/quarantined bytes now
    // live in the server's own dirs; failed/rejected partials must not linger.
    await rm(entry.savePath, { force: true }).catch(() => { /* already gone */ });
  }
}

export function getRecentDownloads(sessionId?: string, limit = 5): DownloadRecord[] {
  return records.filter((record) => !sessionId || record.sessionId === sessionId).slice(-limit).map((record) => ({ ...record }));
}

export function formatRecentDownloads(sessionId: string): string {
  const recent = getRecentDownloads(sessionId);
  if (!recent.length) return "No browser downloads recorded for this session.";
  return recent.map((r) => `[${r.id}] ${r.status.toUpperCase()}: ${r.filename} (${r.size} bytes, ${r.detectedType})\n${r.reason}${r.releasePath ? `\nReleased to: ${r.releasePath}` : ""}`).join("\n\n");
}

export interface DownloadApprovalBinding {
  download_id: string;
  digest: string;
  size: number;
  filename: string;
  content_type: string;
  detected_type: string;
}

export function getDownloadApprovalBinding(sessionId: string, id: string): DownloadApprovalBinding {
  const record = records.find((item) => item.id === id && item.sessionId === sessionId);
  if (!record || record.status !== "quarantined" || !record.quarantinePath) throw new Error("Quarantined download not found in this browser session.");
  return {
    download_id: id, digest: record.digest, size: record.size, filename: record.filename,
    content_type: record.contentType, detected_type: record.detectedType,
  };
}

export async function releaseQuarantinedDownload(sessionId: string, id: string, approved: DownloadApprovalBinding, releaseDirOverride?: string): Promise<DownloadRecord> {
  const record = records.find((item) => item.id === id && item.sessionId === sessionId);
  if (!record) throw new Error("Download not found in this browser session.");
  if (record.status !== "quarantined" || !record.quarantinePath) throw new Error(`Download is ${record.status} and cannot be released.`);
  const current = getDownloadApprovalBinding(sessionId, id);
  if (JSON.stringify(current) !== JSON.stringify(approved)) throw new Error("Approved download metadata no longer matches the quarantined file.");
  const releaseDir = resolve(releaseDirOverride ?? join(getRuntimeConfig().workspace, "downloads"));
  mkdirSync(releaseDir, { recursive: true, mode: 0o700 });
  try {
    record.releasePath = await publishVerifiedDownload(record.quarantinePath, releaseDir, record.filename, approved);
    record.status = "released";
    record.reason = "Released after explicit user approval bound to the inspected digest and metadata.";
    delete record.quarantinePath;
    if (record.metadataPath) await writeFile(record.metadataPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    return { ...record };
  } catch (error) {
    record.status = "rejected";
    record.reason = `Release rejected: ${(error as Error).message}`;
    if (record.quarantinePath) await rm(record.quarantinePath, { force: true });
    delete record.quarantinePath;
    if (record.metadataPath) await writeFile(record.metadataPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    throw error;
  }
}

async function responseContentType(response: Response, map: Map<string, string>): Promise<void> {
  try {
    const headers = await response.allHeaders();
    const type = headers["content-type"];
    if (type) map.set(response.url(), type);
    if (map.size > 100) map.delete(map.keys().next().value!);
  } catch { /* response may disappear during navigation */ }
}

export function installDownloadHandler(page: Page, sessionId = "default"): void {
  if (installedPages.has(page)) return;
  installedPages.add(page);
  const contentTypes = new Map<string, string>();
  page.on("response", (response) => { void responseContentType(response, contentTypes); });
  page.on("download", async (download: Download) => {
    const sourceUrl = download.url();
    const pageUrl = page.url();
    const suggestedFilename = download.suggestedFilename();
    try {
      const stream = await download.createReadStream();
      if (!stream) throw new Error((await download.failure()) || "Download stream was unavailable.");
      const record = await inspectBrowserDownload({
        sessionId, sourceUrl, pageUrl, suggestedFilename,
        contentType: contentTypes.get(sourceUrl), stream,
      });
      const failure = await download.failure();
      if (failure) {
        if (record.releasePath) await rm(record.releasePath, { force: true });
        if (record.quarantinePath) await rm(record.quarantinePath, { force: true });
        delete record.releasePath;
        delete record.quarantinePath;
        record.status = "failed";
        record.reason = "Browser reported an incomplete download; partial bytes were removed.";
        if (record.metadataPath) await writeFile(record.metadataPath, JSON.stringify(record, null, 2), { mode: 0o600 });
      }
      browserLogger.info(`[downloads] ${record.status} ${record.filename} from ${sourceOrigin(sourceUrl)}`);
    } catch (error) {
      await download.cancel().catch(() => { /* delete below owns final cleanup */ });
      recordFailure(sessionId, sourceUrl, pageUrl, suggestedFilename, `Download failed and partial bytes were removed: ${(error as Error).message}`);
      browserLogger.warn(`[downloads] failed from ${sourceOrigin(sourceUrl)}: ${(error as Error).message}`);
    } finally {
      const nativePath = await download.path().catch(() => null);
      await download.delete().catch(() => { /* explicit path removal below is the fallback */ });
      if (nativePath && isInsideDirectory(nativePath, getBrowserNativeDownloadDir())) await rm(nativePath, { force: true });
    }
  });
}
