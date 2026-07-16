/**
 * Shared bookmarks — one JSON store used by BOTH the user (Library panel /
 * routes) and agents (`browser` tool `bookmark_add` / `bookmarks` actions).
 * "Post it to the usual place" works because there IS one usual place.
 *
 * Mirrors BrowserProfileStore in structure: JSON singleton under getLaxDir(),
 * load-with-catch, writeFileSync persist. Deduped by url — re-adding an
 * existing url updates its title/tags instead of minting a second row.
 *
 * Bookmark urls deliberately KEEP query strings and fragments (a bookmark to
 * a specific video/search would be useless without them) — that's why this
 * store does NOT run the history privacy law. Two credential channels are
 * still closed: URL userinfo (user:pass@host) is stripped, and query/fragment
 * params with credential-shaped NAMES (token, session, code, …) are removed
 * individually — ?v=abc survives, ?session_token=… does not. A bookmark must
 * outlive the session it was made in; a live token never should.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

const BOOKMARKS_FILE = join(getLaxDir(), "browser-bookmarks.json");

export interface BrowserBookmark {
  id: string;
  url: string;
  title: string;
  profileId?: string;
  tags?: string[];
  addedBy: "user" | "agent";
  ts: number;
}

/** Strip URL userinfo (https://user:pass@host/… → https://host/…). */
function stripUserinfo(url: string): string {
  return url.replace(/^([a-z][\w+.-]*:\/\/|\/\/)?[^/@]*@/i, "$1");
}

/** Query/fragment param names that carry live credentials, never identity. */
const CREDENTIAL_PARAM = /^(.*(token|secret|password|passwd|pwd|session|auth|api[-_]?key|credential|otp|signature|sig|code)|sig)$/i;

/** Remove credential-named params from query AND fragment, keep the rest. */
export function scrubCredentialParams(url: string): string {
  const scrubPart = (part: string, sep: "?" | "#"): string => {
    const kept = part
      .split("&")
      .filter((pair) => pair !== "" && !CREDENTIAL_PARAM.test(pair.split("=")[0]));
    return kept.length > 0 ? sep + kept.join("&") : "";
  };
  const hashIdx = url.indexOf("#");
  const beforeHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const hash = hashIdx >= 0 ? url.slice(hashIdx + 1) : null;
  const queryIdx = beforeHash.indexOf("?");
  const base = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;
  const query = queryIdx >= 0 ? scrubPart(beforeHash.slice(queryIdx + 1), "?") : "";
  // Fragments are scrubbed only when param-shaped (#access_token=…); a plain
  // anchor (#section-2) is content, not a credential.
  const fragment = hash === null ? "" : hash.includes("=") ? scrubPart(hash, "#") : "#" + hash;
  return base + query + fragment;
}

export class BrowserBookmarkStore {
  private static instance: BrowserBookmarkStore | null = null;
  private bookmarks: BrowserBookmark[] = [];

  private constructor() { this.load(); }

  static getInstance(): BrowserBookmarkStore {
    if (!BrowserBookmarkStore.instance) BrowserBookmarkStore.instance = new BrowserBookmarkStore();
    return BrowserBookmarkStore.instance;
  }

  /** Test-only: reset the singleton so fixtures don't bleed between cases. */
  static _resetForTest(): void {
    BrowserBookmarkStore.instance = null;
  }

  private load(): void {
    try {
      if (existsSync(BOOKMARKS_FILE)) {
        this.bookmarks = JSON.parse(readFileSync(BOOKMARKS_FILE, "utf-8"));
      }
    } catch { this.bookmarks = []; }
  }

  private persist(): void {
    // 0600 like the repo's other user-private stores; chmod covers a
    // pre-existing looser file (mode only applies on create).
    writeFileSync(BOOKMARKS_FILE, JSON.stringify(this.bookmarks, null, 2), { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(BOOKMARKS_FILE, 0o600); } catch { /* best-effort on Windows ACL setups */ }
  }

  /**
   * Add a bookmark. Deduped by url: re-adding an existing url updates its
   * title/tags (record identity — id, addedBy, ts — is preserved).
   */
  add(input: { url: string; title?: string; profileId?: string; tags?: string[]; addedBy: "user" | "agent" }): BrowserBookmark {
    const url = scrubCredentialParams(stripUserinfo(String(input.url ?? "").trim()));
    if (!url) throw new Error("Bookmark url is required");
    const title = (input.title ?? "").trim();
    const tags = Array.isArray(input.tags)
      ? input.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim())
      : undefined;

    const existing = this.bookmarks.find((b) => b.url === url);
    if (existing) {
      if (title !== "") existing.title = title;
      if (tags !== undefined) existing.tags = tags;
      this.persist();
      return existing;
    }

    const bookmark: BrowserBookmark = {
      id: "bm-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex"),
      url,
      title,
      addedBy: input.addedBy,
      ts: Date.now(),
    };
    if (input.profileId) bookmark.profileId = input.profileId;
    if (tags !== undefined && tags.length > 0) bookmark.tags = tags;
    this.bookmarks.push(bookmark);
    this.persist();
    return bookmark;
  }

  /** Newest-first, optional case-insensitive substring match on url, title,
   *  and tags, optional profile filter. */
  list(filter: { q?: string; profileId?: string } = {}): BrowserBookmark[] {
    const needle = (filter.q ?? "").trim().toLowerCase();
    // ts-desc with insertion-order tiebreak — two adds in the same millisecond
    // must still list newest (later-inserted) first.
    return this.bookmarks
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => {
        if (filter.profileId && b.profileId !== filter.profileId) return false;
        if (!needle) return true;
        const hay = `${b.url} ${b.title} ${(b.tags ?? []).join(" ")}`.toLowerCase();
        return hay.includes(needle);
      })
      .sort((x, y) => (y.b.ts - x.b.ts) || (y.idx - x.idx))
      .map(({ b }) => b);
  }

  get(id: string): BrowserBookmark | null {
    return this.bookmarks.find((b) => b.id === id) || null;
  }

  remove(id: string): boolean {
    const before = this.bookmarks.length;
    this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
    if (this.bookmarks.length === before) return false;
    this.persist();
    return true;
  }
}
