import type { Download, Page } from "playwright";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { createLogger } from "../logger.js";

const browserLogger = createLogger("browser.downloads");

// Hard ceiling on a single saved download. Playwright's Download API exposes
// no size before saveAs (no content-length surface), so enforcement is
// save → stat → delete-if-over. Without a cap a hostile page can fill the
// disk with one link. 512 MB is far above any file the agent can usefully
// read, and well below disk-filling territory. Not user-configurable yet —
// revisit if a legitimate >512 MB workflow shows up.
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

function getDownloadsDir(): string {
  const cfg = getRuntimeConfig();
  const dir = resolve(cfg.workspace, "downloads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function uniqueDownloadPath(dir: string, suggested: string): string {
  const safe = suggested.replace(/[<>:"|?*\x00-\x1f]/g, "_") || "download.bin";
  let candidate = join(dir, safe);
  if (!existsSync(candidate)) return candidate;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(dir, `${stem}-${Date.now()}${ext}`);
}

export interface DownloadRecord {
  url: string;
  path: string;
  name: string;
  size: number;
  ts: number;
  /** Monotonic per-process sequence — cursor key for downloadsSince(). */
  seq: number;
  /** Owning browser session (BrowserManager sessionId). recentDownloads is
   *  process-wide, so without this stamp session A's observations would
   *  report session B's downloads — misattribution and a privacy leak
   *  (a mission's download surfacing inside an unrelated chat session). */
  sessionKey: string;
  /** Set when the file exceeded MAX_DOWNLOAD_BYTES and was deleted post-save. */
  removedOversize?: boolean;
}

let nextSeq = 1;

export const recentDownloads: DownloadRecord[] = [];

export function getRecentDownloads(limit = 5): DownloadRecord[] {
  return recentDownloads.slice(-limit);
}

/** Highest seq issued so far — snapshot this at session start so a new
 *  session doesn't surface downloads that predate it. */
export function latestDownloadSeq(): number {
  return nextSeq - 1;
}

/** Downloads recorded after the given cursor, scoped to one session — a
 *  session must never surface (or consume) another session's downloads. */
export function downloadsSince(afterSeq: number, sessionKey: string): DownloadRecord[] {
  return recentDownloads.filter((d) => d.seq > afterSeq && d.sessionKey === sessionKey);
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Compact observation section for downloads — "" when there are none. */
export function formatDownloadNote(entries: DownloadRecord[]): string {
  if (entries.length === 0) return "";
  const lines = ["== DOWNLOADS (saved to workspace/downloads/) =="];
  for (const d of entries) {
    if (d.removedOversize) {
      lines.push(`  BLOCKED ${d.name} — ${fmtBytes(d.size)} exceeds the ${fmtBytes(MAX_DOWNLOAD_BYTES)} download cap; file was deleted`);
    } else {
      lines.push(`  ${d.name} (${fmtBytes(d.size)}) → ${d.path}`);
    }
  }
  return lines.join("\n");
}

// Idempotence guard (same pattern as dialog-handler's WeakMap): adoptPage
// runs on every switch_tab, so without this a page flipped between N times
// accumulates N listeners — each racing uniqueDownloadPath for the same file
// (collisions/duplicates) and tripping the MaxListeners warning.
const installedPages = new WeakSet<Page>();

// Without this handler, Playwright aborts navigation with "Download is
// starting" and the file lands nowhere. Save to workspace/downloads/ so the
// file is reachable from agent tools (read, view_image, edit). The directory
// is deliberately EXCLUDED from workspace git sync (SKIP_DIRS in
// sync/constants.ts) — arbitrary web files must not propagate across machines.
// `sessionKey` is the owning BrowserManager's sessionId — pages are owned by
// exactly one session (manager.owned), so first-install wins is correct.
export function installDownloadHandler(page: Page, sessionKey: string): void {
  if (installedPages.has(page)) return;
  installedPages.add(page);
  page.on("download", async (download: Download) => {
    try {
      const dir = getDownloadsDir();
      const dest = uniqueDownloadPath(dir, download.suggestedFilename());
      await download.saveAs(dest);
      const size = statSync(dest).size;
      const record: DownloadRecord = {
        url: download.url(), path: dest, name: basename(dest), size, ts: Date.now(), seq: nextSeq++, sessionKey,
      };
      if (size > MAX_DOWNLOAD_BYTES) {
        unlinkSync(dest);
        record.removedOversize = true;
        browserLogger.warn(`[downloads] deleted oversized download ${record.name} (${size} bytes > ${MAX_DOWNLOAD_BYTES} cap) from ${download.url().slice(0, 80)}`);
      } else {
        browserLogger.info(`[downloads] saved ${download.url().slice(0, 80)} → ${dest}`);
      }
      recentDownloads.push(record);
      if (recentDownloads.length > 50) recentDownloads.shift();
    } catch (e) {
      browserLogger.warn(`[downloads] saveAs failed: ${(e as Error).message}`);
    }
  });
}
