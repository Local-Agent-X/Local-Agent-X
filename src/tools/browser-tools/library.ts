/**
 * Library actions — shared history + bookmarks over the same stores the
 * user's Library panel reads (BrowserHistoryStore / BrowserBookmarkStore).
 *
 *   history      — read-only search of recorded visits (newest first).
 *   bookmark_add — save a bookmark; defaults to the ACTIVE page (url/title
 *                  pulled from the live backend), stamped addedBy:"agent".
 *   bookmarks    — read-only list, optional 'find' filter.
 *
 * Listings are wrapped as external content: titles are page-controlled text
 * and history/bookmark rows re-enter agent context.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserBackend } from "../../browser/index.js";
import { ok, err } from "./shared.js";
import { wrapExternalContent } from "../../sanitize.js";
import { BrowserHistoryStore, type HistoryEntry } from "../../browser/history-store.js";
import { BrowserBookmarkStore, type BrowserBookmark } from "../../browser/bookmark-store.js";

const HISTORY_DEFAULT_LIMIT = 25;
const HISTORY_MAX_LIMIT = 100;

function when(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function historyLine(e: HistoryEntry): string {
  const title = e.title ? `${e.title} — ` : "";
  const profile = e.profileId !== "default" ? ` (profile ${e.profileId})` : "";
  return `- [${when(e.ts)}] ${title}${e.url}${profile}`;
}

function bookmarkLine(b: BrowserBookmark): string {
  const title = b.title ? `${b.title} — ` : "";
  const tags = b.tags && b.tags.length > 0 ? ` [${b.tags.join(", ")}]` : "";
  return `- ${title}${b.url}${tags} (${b.addedBy}, ${when(b.ts)}, id: ${b.id})`;
}

/** Read-only. args.find = substring query over url+title; args.limit caps rows. */
export function handleHistory(args: Record<string, unknown>): ToolResult {
  const find = args.find ? String(args.find) : undefined;
  const rawLimit = Number(args.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, HISTORY_MAX_LIMIT)
    : HISTORY_DEFAULT_LIMIT;
  // Shared history: no profile filter — user views record under "default",
  // agent sessions under their own profile, and "that site from yesterday"
  // should match regardless of who visited it.
  const entries = BrowserHistoryStore.getInstance().query({ q: find, limit });
  if (entries.length === 0) {
    return ok(find ? `No history entries match "${find}".` : "Browser history is empty.");
  }
  const header = `Browser history (${entries.length} entr${entries.length === 1 ? "y" : "ies"}, newest first${find ? `, matching "${find}"` : ""}):`;
  return ok(`${header}\n${wrapExternalContent(entries.map(historyLine).join("\n"), "browser.history")}`);
}

/**
 * Save a bookmark. url/title default to the ACTIVE page: url from the live
 * backend, title parsed from its getInfo() report (the same "Title: …" line
 * the info action returns).
 */
export async function handleBookmarkAdd(
  manager: BrowserBackend,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let url = args.url ? String(args.url).trim() : "";
  let title = args.title ? String(args.title).trim() : "";
  if (!url) {
    url = manager.getCurrentUrl();
    if (!url || url === "about:blank") {
      return err("No 'url' given and no page is open. Pass 'url' or navigate somewhere first.");
    }
    if (!title) {
      const info = await manager.getInfo();
      const match = info.match(/^Title: (.*)$/m);
      if (match) title = match[1].trim();
    }
  }
  const bookmark = BrowserBookmarkStore.getInstance().add({
    url,
    title,
    profileId: manager.getProfileId(),
    addedBy: "agent",
  });
  // title/url are page-controlled — same external-content posture as the
  // listings, even for this one-line echo.
  return ok(`Bookmarked (id: ${bookmark.id}):\n${wrapExternalContent(`${bookmark.title ? `${bookmark.title} — ` : ""}${bookmark.url}`, "browser.bookmark-add")}`);
}

/** Read-only. args.find = substring query over url+title+tags. */
export function handleBookmarks(args: Record<string, unknown>): ToolResult {
  const find = args.find ? String(args.find) : undefined;
  const bookmarks = BrowserBookmarkStore.getInstance().list({ q: find });
  if (bookmarks.length === 0) {
    return ok(find ? `No bookmarks match "${find}".` : "No bookmarks saved yet.");
  }
  const header = `Bookmarks (${bookmarks.length}, newest first${find ? `, matching "${find}"` : ""}) — shared between you and the user:`;
  return ok(`${header}\n${wrapExternalContent(bookmarks.map(bookmarkLine).join("\n"), "browser.bookmarks")}`);
}
