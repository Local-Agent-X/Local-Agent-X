// Atomic entry-based memory store. The structured-markdown stores
// (USER.md / MIND.md / IDENTITY.md / HEART.md) require the model to
// pick the right action + heading on every save — get it wrong once and
// the file accumulates contradictory bullets across duplicated sections
// that the next chat sees as conflicting truths.
//
// This store sidesteps that entire failure class:
//   - One file = one flat list of atomic entries
//   - Entries are separated by U+00A7 (§), which is unlikely to appear
//     in natural-language facts and is easy to spot in raw files
//   - `replace` finds entries by SUBSTRING, not heading — the model
//     identifies what to update by content it already knows, not by
//     remembering the file's structural shape
//   - `remove` works the same way
//   - Writes go through a file lock + atomic rename, so a second writer
//     can't half-clobber the first
//   - Reads detect external drift (entry larger than the per-file cap,
//     or content that wouldn't round-trip through our serializer) and
//     refuse to write until the drift is resolved — prevents silent
//     data loss when a patch tool, shell append, or sister session
//     modifies the file out of band

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";

export const ENTRY_DELIMITER = "\n§\n";

export interface EntryStoreOptions {
  /** Absolute path to the directory holding the file. */
  baseDir: string;
  /** Filename inside baseDir (e.g. "FACTS.md"). */
  filename: string;
  /** Character cap for the whole serialized file. Writes that would
   *  exceed this are refused with a clear retry hint. */
  charLimit: number;
}

export interface EntryStoreResult {
  success: boolean;
  message?: string;
  error?: string;
  entries?: string[];
  usage?: string;
  driftBackup?: string;
}

// Cross-platform poor-man's file lock: a separate `.lock` sibling file
// opened exclusively. Best-effort — Node has no portable advisory lock —
// but the open(O_EXCL) atomicity is enough for the in-process + within-
// machine concurrent-write case we actually face.
function withLock<T>(filePath: string, fn: () => T): T {
  const lockPath = filePath + ".lock";
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number | null = null;
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      // Stale lock cleanup: if the lock file is older than 30s, an
      // earlier process crashed without releasing. Stomp it.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > 30_000) unlinkSync(lockPath);
      } catch { /* race; retry */ }
      if (Date.now() > deadline) {
        throw new Error(`could not acquire memory lock at ${lockPath} after 2s`);
      }
      // Tight retry — locks here are sub-ms in practice.
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(lockPath); } catch {}
  }
}

// Atomic write: write to .tmp + fsync + rename. Readers always see
// either the old complete file or the new complete file — never a
// half-written one. Skipping this in favor of plain writeFileSync was
// what made concurrent writes silently lose data in the old code path.
function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, content, 0, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
}

function parseEntries(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  // Strip a single leading/trailing delimiter pair so files written by
  // older versions (or hand-edited) parse cleanly.
  const parts = raw.split(ENTRY_DELIMITER);
  const cleaned = parts.map((e) => e.trim()).filter((e) => e.length > 0);
  // Preserve order, drop exact duplicates — covers the case where the
  // model adds the same fact twice in quick succession.
  return Array.from(new Set(cleaned));
}

function serializeEntries(entries: string[]): string {
  return entries.length ? entries.join(ENTRY_DELIMITER) : "";
}

export class EntryStore {
  private readonly path: string;
  private readonly charLimit: number;

  constructor(opts: EntryStoreOptions) {
    this.path = join(opts.baseDir, opts.filename);
    this.charLimit = opts.charLimit;
  }

  /** Current on-disk entries. Always reads fresh — the store is small
   *  enough that the round trip is irrelevant compared to the safety
   *  of always seeing the latest state. */
  list(): string[] {
    if (!existsSync(this.path)) return [];
    try {
      return parseEntries(readFileSync(this.path, "utf-8"));
    } catch {
      return [];
    }
  }

  /** Drift detection. The file is supposed to be a list of small
   *  entries joined by §. If something else wrote into it that wouldn't
   *  round-trip — wrong delimiter style, or a single "entry" larger
   *  than the whole file's cap — back the disk content up and report
   *  the path so the caller can refuse to overwrite. */
  private detectDriftAndBackup(): string | null {
    if (!existsSync(this.path)) return null;
    let raw: string;
    try { raw = readFileSync(this.path, "utf-8"); }
    catch { return null; }
    if (!raw.trim()) return null;
    const parsed = parseEntries(raw);
    const roundTrip = serializeEntries(parsed);
    const maxEntryLen = parsed.reduce((m, e) => Math.max(m, e.length), 0);
    const drift = raw.trim() !== roundTrip.trim() || maxEntryLen > this.charLimit;
    if (!drift) return null;
    const bakPath = `${this.path}.bak.${Date.now()}`;
    try { writeFileSync(bakPath, raw, "utf-8"); }
    catch { return null; }
    return bakPath;
  }

  private result(message: string, entries: string[]): EntryStoreResult {
    const total = serializeEntries(entries).length;
    const pct = this.charLimit > 0 ? Math.min(100, Math.round((total / this.charLimit) * 100)) : 0;
    return {
      success: true,
      message,
      entries,
      usage: `${pct}% — ${total}/${this.charLimit} chars`,
    };
  }

  /** Append a new entry. No-op if an identical entry already exists. */
  add(content: string): EntryStoreResult {
    const trimmed = content.trim();
    if (!trimmed) return { success: false, error: "content is required" };
    return withLock(this.path, () => {
      const bak = this.detectDriftAndBackup();
      if (bak) return { success: false, error: `external drift detected; backed up to ${bak}`, driftBackup: bak };
      const entries = this.list();
      if (entries.includes(trimmed)) {
        return this.result("entry already exists (no duplicate added)", entries);
      }
      const next = [...entries, trimmed];
      const nextTotal = serializeEntries(next).length;
      if (nextTotal > this.charLimit) {
        return {
          success: false,
          error: `cap reached: ${nextTotal}/${this.charLimit} chars after add. Use 'replace' on a stale entry or 'remove' something first.`,
          entries,
        };
      }
      atomicWrite(this.path, serializeEntries(next));
      return this.result("entry added", next);
    });
  }

  /** Find ONE entry containing `oldText` and replace it with `content`.
   *  If multiple entries match different texts, returns an error with
   *  the matches so the model can pick a more specific substring. If
   *  all matches are identical, the first one is replaced. */
  replace(oldText: string, content: string): EntryStoreResult {
    const needle = oldText.trim();
    const next = content.trim();
    if (!needle) return { success: false, error: "old_text is required" };
    if (!next) return { success: false, error: "content is required (use 'remove' to delete)" };
    return withLock(this.path, () => {
      const bak = this.detectDriftAndBackup();
      if (bak) return { success: false, error: `external drift detected; backed up to ${bak}`, driftBackup: bak };
      const entries = this.list();
      const matches = entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.includes(needle));
      if (matches.length === 0) {
        return { success: false, error: `no entry contained "${needle}"`, entries };
      }
      const distinct = new Set(matches.map((m) => m.e));
      if (distinct.size > 1) {
        return {
          success: false,
          error: `ambiguous: ${matches.length} entries match "${needle}" with different content. Use a more specific substring.`,
          entries: matches.map((m) => m.e.slice(0, 120)),
        };
      }
      const idx = matches[0].i;
      const candidate = [...entries];
      candidate[idx] = next;
      const total = serializeEntries(candidate).length;
      if (total > this.charLimit) {
        return {
          success: false,
          error: `cap reached: ${total}/${this.charLimit} chars after replace. Shorten the new content or remove other entries.`,
          entries,
        };
      }
      atomicWrite(this.path, serializeEntries(candidate));
      return this.result("entry replaced", candidate);
    });
  }

  /** Remove ONE entry matching `oldText`. Same disambiguation rules as
   *  `replace`. */
  remove(oldText: string): EntryStoreResult {
    const needle = oldText.trim();
    if (!needle) return { success: false, error: "old_text is required" };
    return withLock(this.path, () => {
      const bak = this.detectDriftAndBackup();
      if (bak) return { success: false, error: `external drift detected; backed up to ${bak}`, driftBackup: bak };
      const entries = this.list();
      const matches = entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.includes(needle));
      if (matches.length === 0) {
        return { success: false, error: `no entry contained "${needle}"`, entries };
      }
      const distinct = new Set(matches.map((m) => m.e));
      if (distinct.size > 1) {
        return {
          success: false,
          error: `ambiguous: ${matches.length} entries match "${needle}". Use a more specific substring.`,
          entries: matches.map((m) => m.e.slice(0, 120)),
        };
      }
      const idx = matches[0].i;
      const next = entries.filter((_, i) => i !== idx);
      atomicWrite(this.path, serializeEntries(next));
      return this.result("entry removed", next);
    });
  }

  /** Snapshot block for system-prompt assembly. Returns null when the
   *  store is empty — keeps a "nothing to inject" surface clean. */
  renderForSystemPrompt(header: string): string | null {
    const entries = this.list();
    if (!entries.length) return null;
    return `${header}\n\n${entries.join("\n\n")}`;
  }
}
