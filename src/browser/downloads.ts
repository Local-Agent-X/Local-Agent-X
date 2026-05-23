import type { Download, Page } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { createLogger } from "../logger.js";

const browserLogger = createLogger("browser.downloads");

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

export const recentDownloads: Array<{ url: string; path: string; ts: number }> = [];

export function getRecentDownloads(limit = 5): Array<{ url: string; path: string; ts: number }> {
  return recentDownloads.slice(-limit);
}

// Without this handler, Playwright aborts navigation with "Download is
// starting" and the file lands nowhere. Save to workspace/downloads/ so the
// file is reachable from agent tools (read, view_image, edit) AND syncs across
// machines via the workspace git sync. Users are expected to clean up huge
// files themselves (>100MB will break GitHub sync — agent should warn).
export function installDownloadHandler(page: Page): void {
  page.on("download", async (download: Download) => {
    try {
      const dir = getDownloadsDir();
      const dest = uniqueDownloadPath(dir, download.suggestedFilename());
      await download.saveAs(dest);
      recentDownloads.push({ url: download.url(), path: dest, ts: Date.now() });
      if (recentDownloads.length > 50) recentDownloads.shift();
      browserLogger.info(`[downloads] saved ${download.url().slice(0, 80)} → ${dest}`);
    } catch (e) {
      browserLogger.warn(`[downloads] saveAs failed: ${(e as Error).message}`);
    }
  });
}
