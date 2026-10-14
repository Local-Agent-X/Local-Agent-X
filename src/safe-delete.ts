import { existsSync, mkdirSync, renameSync, cpSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { osTrash } from "./os-trash.js";
import { appendTrashJournal, findTrashEntry, listRestorable, type TrashTier } from "./trash-journal.js";
import { createLogger } from "./logger.js";

const logger = createLogger("safe-delete");
const RETENTION_DAYS = 30;
/** Closed task-trash scopes linger this long after their `.closed` marker, then sweep. */
export const TASK_TRASH_TTL_MS = 24 * 3_600_000;

// Recoverable delete for USER data. Destructive ops on the workspace
// (delete_file, app_delete, project-roster delete) route here instead of
// unlink/rmSync so a mistake can be undone. Build artifacts, caches and temp
// dirs still hard-delete; only user data routes through here.
//
// Three tiers:
//   1. The real OS Trash / Recycle Bin — discoverable: the user browses,
//      restores and empties it the normal way, no hidden folder. Preferred
//      route is the Electron-main bridge (shell.trashItem), which records the
//      original location so macOS "Put Back" / Windows-Linux "Restore" work.
//      Standalone (no desktop) falls back to a direct move into the OS trash
//      dir — recoverable, but without Put Back metadata on macOS. The tier
//      lives in os-trash.ts, with the Windows guard against a bin that
//      destroys what it will not hold.
//   2. Fallback to ~/.lax/trash/<YYYY-MM-DD>/ when no OS trash is reachable
//      (headless server, no GUI session, missing `gio`) — the data is still
//      recoverable, just from a dotfolder.
//   3. Task-scoped trash under ~/.lax/trash/task/<sessionId>/ for files the
//      AGENT ITSELF created during a task (data-lineage/task-artifacts.ts):
//      the delete stays programmatically restorable (restore_file) until the
//      task's scope is closed, then a short TTL reclaims the space. The OS
//      Trash can't serve this tier — native trash has no machine-readable
//      restore API, and agent scratch output would spam the user's bin.
//
// (2026-06-10: a misdirected workspace migration perma-deleted the user's apps;
// only the ~/.lax snapshots saved them. This makes the next such slip land in
// the recycle bin instead.)

function trashRoot(): string {
  return join(getLaxDir(), "trash");
}

/** Move a file or directory to the recycle bin. Returns a human-readable
 *  location (for surfacing to the user) or null if the source didn't exist.
 *  `appTrashOnly` skips the OS bin: a folder whose restore is promised goes
 *  straight to the app's own trash, a rename. The journal line records the
 *  exact in-trash path whenever this side knows it, so a restore moves the
 *  bytes back rather than searching for them. */
export async function moveToTrash(path: string, reason?: string, opts: { appTrashOnly?: boolean } = {}): Promise<string | null> {
  if (!existsSync(path)) return null;
  const tag = reason ? ` (${reason})` : "";

  const original = resolve(path);
  const now = new Date();
  const dir = join(trashRoot(), now.toISOString().slice(0, 10));
  const dest = join(dir, `${basename(path)}.${now.getTime()}`);
  const journal = (tier: TrashTier, at: string | null): void =>
    appendTrashJournal({ original, tier, dest: at, kind: "file", ...(reason ? { reason } : {}) });

  if (!opts.appTrashOnly) {
    const taken = await osTrash(path, dest);
    if (taken?.tier === "os") {
      logger.info(`[trash] ${path} -> OS recycle bin${tag}`);
      journal("os", taken.dest);
      return "the system Trash";
    }
    if (taken) {
      logger.info(`[trash] ${path} -> ${taken.dest}${tag} (kept out of the Recycle Bin)`);
      journal("lax", taken.dest);
      sweepOldTrash();
      return taken.dest;
    }
  }

  // Fallback: app-managed recycle bin under ~/.lax.
  mkdirSync(dir, { recursive: true });
  try {
    renameSync(path, dest);
  } catch {
    cpSync(path, dest, { recursive: true });
    rmSync(path, { recursive: true, force: true });
  }
  logger.info(`[trash] ${path} -> ${dest}${tag}`);
  journal("lax", dest);
  sweepOldTrash();
  return dest;
}

/** Snapshot a deleted CONFIG record (a project container, an agent definition)
 *  as JSON so the deletion is recoverable. Metadata goes to ~/.lax/trash, not
 *  the OS Trash — a cryptic `project-….json` in Finder isn't something a user
 *  can "Put Back". Best-effort: never throws into the caller's delete path. */
export function trashRecord(name: string, data: unknown): void {
  try {
    const now = new Date();
    const dir = join(trashRoot(), now.toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dest = join(dir, `${safe}.${now.getTime()}.json`);
    writeFileSync(dest, JSON.stringify(data, null, 2), "utf-8");
    logger.info(`[trash] snapshot ${name} -> ${dest}`);
    // Journalled like any other deletion: these snapshots were write-only for
    // months — the bytes were on disk and no code could name them, so a
    // deleted project was unrecoverable in practice.
    appendTrashJournal({ original: name, tier: "record", dest, kind: "record" });
    sweepOldTrash();
  } catch (e) {
    logger.warn(`[trash] failed to snapshot ${name}: ${(e as Error).message}`);
  }
}

/** Read a snapshot back. The counterpart trashRecord never had: for months it
 *  wrote a deleted project's or agent's JSON to disk and nothing could name
 *  the file again, so "recoverable" was true of the bytes and false of the
 *  product. Returns the most recent snapshot for `name`, or null. */
export function readTrashRecord<T = unknown>(name: string): T | null {
  const entry = findTrashEntry(name, { kind: "record" });
  if (!entry?.dest || !existsSync(entry.dest)) return null;
  try {
    return JSON.parse(readFileSync(entry.dest, "utf-8")) as T;
  } catch (e) {
    logger.warn(`[trash] snapshot for ${name} is unreadable: ${(e as Error).message}`);
    return null;
  }
}

/** Snapshots still on disk, newest first — what a restore could offer. */
export function listTrashRecords(limit?: number): Array<{ name: string; at: number; path: string }> {
  return listRestorable({ kind: "record", ...(limit ? { limit } : {}) })
    .map((e) => ({ name: e.original, at: e.at, path: e.dest as string }));
}

// ---- Task-scoped trash tier (tier 3) ---------------------------------------
// One scope directory per session, one manifest per scope (the trashRecord
// idea, made per-scope): the manifest maps each trashed name back to the
// ORIGINAL absolute path so restore_file can put the bytes back exactly where
// they came from. Manifest reads are defensive: a missing manifest is an
// empty scope, a corrupt one is reconstructed from the directory listing —
// never a throw into a delete or restore path.
//
// NOTE: the exported task-trash API assumes SINGLE-PROCESS callers (LAX's
// sequential tool dispatcher). Manifest read-modify-write is not locked
// against concurrent writers from other processes.

const TASK_MANIFEST = ".manifest.json";
const TASK_CLOSED_MARKER = ".closed";

// `original: null` + `recovered` = the entry was reconstructed after manifest
// corruption: the absolute path is lost, the bytes are not (see recover below).
type TaskTrashEntry = { original: string | null; trashed: string; at: number; recovered?: true };

function taskTrashRoot(): string {
  return join(trashRoot(), "task");
}

function taskScopeDir(sessionId: string): string {
  return join(taskTrashRoot(), sessionId.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

/** Defensive manifest read: a MISSING manifest is an empty scope; a CORRUPT
 *  one is reconstructed from the directory listing so already-trashed bytes
 *  never become API-orphaned (on disk but unrestorable). Never throws. */
function readTaskManifest(dir: string): TaskTrashEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, TASK_MANIFEST), "utf-8"));
    if (Array.isArray(raw)) {
      const entries = raw.filter((e): e is TaskTrashEntry =>
        !!e && typeof (e as TaskTrashEntry).trashed === "string" &&
        ((e as TaskTrashEntry).original === null || typeof (e as TaskTrashEntry).original === "string"));
      // A valid-JSON garbage ARRAY (non-empty, every entry failing the shape
      // filter — e.g. ["garbage", 42]) is corruption wearing an array's
      // clothes, not an empty scope: silently returning [] would API-orphan
      // whatever is already trashed here. Reconstruct like any other corrupt
      // manifest. A truly empty [] (or a partially-valid array) is honored.
      if (entries.length > 0 || raw.length === 0) return entries;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
  }
  return recoverTaskManifest(dir);
}

// The original absolute paths are lost with the manifest — record null with a
// `recovered` marker so basename / in-trash-name refs still resolve; restore
// then asks for an explicit destination (see restoreFromTaskTrash).
function recoverTaskManifest(dir: string): TaskTrashEntry[] {
  try {
    const entries: TaskTrashEntry[] = [];
    for (const name of readdirSync(dir)) {
      if (name === TASK_MANIFEST || name === TASK_CLOSED_MARKER) continue;
      entries.push({ original: null, trashed: name, at: statSync(join(dir, name)).mtimeMs, recovered: true });
    }
    entries.sort((a, b) => a.at - b.at);
    logger.warn(`[trash] task manifest unreadable in ${dir} — recovered ${entries.length} entries from the listing`);
    return entries;
  } catch {
    return [];
  }
}

function writeTaskManifest(dir: string, entries: TaskTrashEntry[]): void {
  writeFileSync(join(dir, TASK_MANIFEST), JSON.stringify(entries, null, 2), "utf-8");
}

/** Move an AGENT-CREATED file (task-artifact registry hit) into the session's
 *  task-trash scope. Same timestamp-suffix style as the tier-2 fallback, plus
 *  a manifest entry recording the original absolute path so restore_file can
 *  bring it back byte-identical. Returns the in-trash destination, or null if
 *  the source didn't exist. */
export function moveToTaskTrash(sessionId: string, path: string): string | null {
  if (!existsSync(path)) return null;
  const dir = taskScopeDir(sessionId);
  mkdirSync(dir, { recursive: true });
  // New trash activity RE-OPENS the scope: a session trashing again is alive.
  // Without this, a scope whose `.closed` marker is already past the TTL
  // would be purged by the self-invoked sweep below — taking the file
  // trashed microseconds earlier with it while delete_file reports it
  // restorable. Belt: the sweep call also excludes this scope outright.
  rmSync(join(dir, TASK_CLOSED_MARKER), { force: true });
  const stamp = Date.now();
  let dest = join(dir, `${basename(path)}.${stamp}`);
  for (let n = 1; existsSync(dest); n++) dest = join(dir, `${basename(path)}.${stamp}-${n}`);
  const original = resolve(path);
  // Read BEFORE the move: if the manifest is corrupt, the recovery listing
  // must not see the incoming file — it gets its own real entry below.
  const entries = readTaskManifest(dir);
  try {
    renameSync(path, dest);
  } catch {
    cpSync(path, dest, { recursive: true });
    rmSync(path, { recursive: true, force: true });
  }
  entries.push({ original, trashed: basename(dest), at: stamp });
  writeTaskManifest(dir, entries);
  logger.info(`[trash] ${path} -> ${dest} (task scope ${sessionId})`);
  appendTrashJournal({ original, tier: "task", dest, kind: "file", sessionId, at: stamp });
  sweep(dir); // belt: never sweep the scope that just received these bytes
  return dest;
}

/** Restore a task-trashed file byte-identical to its original path. `ref` may
 *  be the original absolute path, its basename, or the in-trash name; when
 *  several entries match (same name deleted twice) the most recent wins.
 *  Refuses to overwrite anything that now exists at the original path.
 *  Returns { restored } on success or { error } (a clear, model-surfaceable
 *  string) on failure — never throws. */
export function restoreFromTaskTrash(
  sessionId: string,
  ref: string,
): { restored: string } | { error: string } {
  try {
    const dir = taskScopeDir(sessionId);
    const entries = readTaskManifest(dir);
    const stripStamp = (n: string) => n.replace(/\.\d+(?:-\d+)?$/, "");
    const matches = entries.filter((e) =>
      e.trashed === ref ||
      (e.original !== null
        ? e.original === resolve(ref) || basename(e.original) === ref
        : stripStamp(e.trashed) === basename(ref)),
    );
    if (matches.length === 0) {
      return { error: `No task-trash entry matches "${ref}" for this task. Nothing was restored.` };
    }
    const entry = matches[matches.length - 1];
    const src = join(dir, entry.trashed);
    if (!existsSync(src)) {
      return { error: `The trashed copy of ${entry.original ?? entry.trashed} is gone (already swept). Nothing was restored.` };
    }
    // A recovered entry lost its original path with the corrupt manifest:
    // the caller must name the destination (any ref with a directory part).
    const target = entry.original ?? (ref === basename(ref) ? null : resolve(ref));
    if (target === null) {
      return { error: `The original path of ${entry.trashed} was lost when the manifest was recovered after corruption. The bytes are preserved at ${src} — restore again with the full destination path (absolute), keeping the file name: the destination's basename must be "${stripStamp(entry.trashed)}" (a recovered entry only matches a destination that shares the trashed file's basename).` };
    }
    if (existsSync(target)) {
      return { error: `Refusing to overwrite: ${target} already exists. Move or delete it first, then restore again.` };
    }
    mkdirSync(dirname(target), { recursive: true });
    try {
      renameSync(src, target);
    } catch {
      cpSync(src, target, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    }
    writeTaskManifest(dir, entries.filter((e) => e !== entry));
    logger.info(`[trash] restored ${target} (task scope ${sessionId})`);
    return { restored: target };
  } catch (e) {
    return { error: `Restore failed: ${(e as Error).message}` };
  }
}

/** Mark a session's task-trash scope closed (the task ended, restore_file's
 *  window is over): writes a `.closed` marker with the close timestamp. The
 *  sweep purges closed scopes TASK_TRASH_TTL_MS later; an open scope rides
 *  the normal RETENTION_DAYS window instead. Best-effort, never throws; a
 *  session that trashed nothing has no scope and is a no-op. */
export function markTaskTrashScopeClosed(sessionId: string): void {
  try {
    const dir = taskScopeDir(sessionId);
    if (!existsSync(dir)) return;
    writeFileSync(
      join(dir, TASK_CLOSED_MARKER),
      JSON.stringify({ closedAt: Date.now(), closedAtIso: new Date().toISOString() }),
      "utf-8",
    );
  } catch (e) {
    logger.warn(`[trash] failed to close task scope ${sessionId}: ${(e as Error).message}`);
  }
}

/** Purge fallback trash day-folders older than the retention window, plus
 *  task scopes per their lifecycle (closed → TASK_TRASH_TTL_MS after the
 *  marker, open → the same RETENTION_DAYS as the day-folders). Best-effort:
 *  the only hard-delete here, it never touches anything outside ~/.lax/trash
 *  and never throws. Exported for on-demand sweeps (and the suites). */
export function sweepOldTrash(): void {
  sweep();
}

// `excludeTaskScopeDir`: the scope a moveToTaskTrash call is writing into —
// the scope receiving new bytes is never sweep-eligible in the same call.
function sweep(excludeTaskScopeDir?: string): void {
  try {
    const root = trashRoot();
    if (!existsSync(root)) return;
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const day of readdirSync(root)) {
      // "task" parses NaN and is skipped — that tier sweeps itself below.
      const t = Date.parse(day);
      if (!Number.isNaN(t) && t < cutoff) rmSync(join(root, day), { recursive: true, force: true });
    }
    sweepTaskScopes(cutoff, excludeTaskScopeDir);
  } catch { /* retention is best-effort; never break a delete */ }
}

// Task-scope sweep. A CLOSED scope is purged TASK_TRASH_TTL_MS after its
// `.closed` marker; an OPEN scope (task may still be live — or the process
// died before closing it) survives until its last activity is RETENTION_DAYS
// old. Per-scope try/catch: one unreadable scope never blocks the rest.
function sweepTaskScopes(openCutoff: number, excludeDir?: string): void {
  const root = taskTrashRoot();
  if (!existsSync(root)) return;
  for (const scope of readdirSync(root)) {
    const dir = join(root, scope);
    if (dir === excludeDir) continue;
    try {
      const marker = join(dir, TASK_CLOSED_MARKER);
      if (existsSync(marker)) {
        if (Date.now() - closedAtOf(marker) > TASK_TRASH_TTL_MS) rmSync(dir, { recursive: true, force: true });
      } else if (statSync(dir).mtimeMs < openCutoff) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* skip this scope */ }
  }
}

/** closedAt from the marker JSON; falls back to the marker file's mtime when
 *  the content is corrupt (defensive read, like the manifest). */
function closedAtOf(marker: string): number {
  try {
    const at = (JSON.parse(readFileSync(marker, "utf-8")) as { closedAt?: unknown }).closedAt;
    if (typeof at === "number" && Number.isFinite(at)) return at;
  } catch { /* fall through to mtime */ }
  return statSync(marker).mtimeMs;
}
