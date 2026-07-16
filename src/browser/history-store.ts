/**
 * Shared browser history — one JSON store of visited pages, keyed by browser
 * profile, readable by both the user (Library panel) and agents (`browser`
 * tool `history` action). Mirrors BrowserProfileStore in structure: JSON
 * singleton under getLaxDir(), load-with-catch, writeFileSync persist.
 *
 * PRIVACY LAW — every url is passed through redactTarget (the ui-event-store
 * sanitizer, imported, not forked) BEFORE storing:
 *   - query strings / fragments / URL userinfo are stripped,
 *   - opaque token-shaped path segments are elided,
 *   - urls whose remainder still looks credential-shaped are DROPPED entirely.
 * Reusing the orchestrator's sanitizer keeps one law for "what a recorded
 * browsing breadcrumb may contain" (layering note: this is a browser →
 * orchestrator import; the redaction rules live in ui-event-store because it
 * was the first consumer — accepted over forking the regex, per one-source-
 * of-truth. If a third consumer appears, hoist redactTarget into a shared
 * module).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { redactTarget } from "../orchestrator/ui-event-store.js";

const HISTORY_FILE = join(getLaxDir(), "browser-history.json");

/** Per-profile entry cap — oldest entries beyond this are evicted. */
export const HISTORY_CAP_PER_PROFILE = 500;

export interface HistoryEntry {
  id: string;
  profileId: string;
  /** Redacted url: host+path only (no query/fragment/userinfo). */
  url: string;
  title: string;
  ts: number;
}

/**
 * Redact a raw url for history storage. Returns null when the url must be
 * dropped (empty after stripping, or credential-shaped remainder).
 */
export function sanitizeHistoryUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  return redactTarget(url);
}

export class BrowserHistoryStore {
  private static instance: BrowserHistoryStore | null = null;
  private entries: HistoryEntry[] = [];

  private constructor() { this.load(); }

  static getInstance(): BrowserHistoryStore {
    if (!BrowserHistoryStore.instance) BrowserHistoryStore.instance = new BrowserHistoryStore();
    return BrowserHistoryStore.instance;
  }

  /** Test-only: reset the singleton so fixtures don't bleed between cases. */
  static _resetForTest(): void {
    BrowserHistoryStore.instance = null;
  }

  private load(): void {
    try {
      if (existsSync(HISTORY_FILE)) {
        this.entries = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
      }
    } catch { this.entries = []; }
  }

  private persist(): void {
    writeFileSync(HISTORY_FILE, JSON.stringify(this.entries, null, 2), "utf-8");
  }

  /**
   * Record a visit. The url is redacted first (see PRIVACY LAW above); a
   * dropped url records nothing and returns null. A visit to the SAME url as
   * the profile's most recent entry collapses into it (ts refreshed, title
   * updated when provided) instead of minting a duplicate row.
   */
  recordVisit(profileId: string, url: string, title = ""): HistoryEntry | null {
    const clean = sanitizeHistoryUrl(url);
    if (clean === null) return null;
    const pid = profileId || "default";
    const now = Date.now();

    const latest = this.latestFor(pid);
    if (latest && latest.url === clean) {
      latest.ts = now;
      if (title.trim() !== "") latest.title = title.trim();
      this.persist();
      return latest;
    }

    const entry: HistoryEntry = {
      id: "hist-" + now.toString(36) + "-" + randomBytes(3).toString("hex"),
      profileId: pid,
      url: clean,
      title: title.trim(),
      ts: now,
    };
    this.entries.push(entry);
    this.evictOldest(pid);
    this.persist();
    return entry;
  }

  /** Stamp a title onto the profile's most recent entry (navigate events carry
   *  no title; it arrives as a follow-up "title" event). No-op without one. */
  touchTitle(profileId: string, title: string): void {
    const latest = this.latestFor(profileId || "default");
    if (!latest || typeof title !== "string" || title.trim() === "") return;
    latest.title = title.trim().slice(0, 300);
    this.persist();
  }

  private latestFor(profileId: string): HistoryEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].profileId === profileId) return this.entries[i];
    }
    return undefined;
  }

  private evictOldest(profileId: string): void {
    let count = 0;
    for (const e of this.entries) if (e.profileId === profileId) count++;
    if (count <= HISTORY_CAP_PER_PROFILE) return;
    let toDrop = count - HISTORY_CAP_PER_PROFILE;
    // Entries are append-ordered, so the first matches are the oldest.
    this.entries = this.entries.filter((e) => {
      if (toDrop > 0 && e.profileId === profileId) { toDrop--; return false; }
      return true;
    });
  }

  /** Newest-first, optional profile filter + case-insensitive substring match
   *  on url and title. */
  query(opts: { profileId?: string; q?: string; limit?: number } = {}): HistoryEntry[] {
    const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? (opts.limit as number) : 50;
    const needle = (opts.q ?? "").trim().toLowerCase();
    const out: HistoryEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (opts.profileId && e.profileId !== opts.profileId) continue;
      if (needle && !e.url.toLowerCase().includes(needle) && !e.title.toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return out;
  }

  /** Delete one entry by id. */
  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }

  /** Clear all history (or one profile's). Returns the number removed. */
  clear(profileId?: string): number {
    const before = this.entries.length;
    this.entries = profileId ? this.entries.filter((e) => e.profileId !== profileId) : [];
    const removed = before - this.entries.length;
    if (removed > 0) this.persist();
    return removed;
  }
}
