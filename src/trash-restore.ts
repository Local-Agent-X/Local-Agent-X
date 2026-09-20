/**
 * Bringing trashed bytes back, from whichever tier holds them.
 *
 * `restore_file` used to reach only the task-scoped tier, so the agent could
 * undo its own scratch output and nothing else. A user's file went to the OS
 * Recycle Bin and stayed there: measured 2026-09-20, a mid-tier model deleted
 * three client originals on a vague "just clear it out", was told to put them
 * back, tried, and had to tell the user to open the Recycle Bin themselves.
 * The bytes were recoverable the whole time; nothing on our side could reach
 * them.
 *
 * The journal (trash-journal.ts) records the original path and the tier at
 * delete time, which leaves only one platform-specific problem: finding the
 * file inside the OS trash, where each platform hides it differently.
 *   - macOS: ~/.Trash/<name>, a flat directory that keeps the file name.
 *   - Linux: the freedesktop spec already writes the original path into a
 *     .trashinfo sidecar, so the lookup is exact.
 *   - Windows: the bin renames the file to $R<random><ext> beside an $I file
 *     holding the original path; the shell's `undelete` verb puts it back.
 *
 * Every path returns { restored } or { error } and never throws: a restore is
 * offered to a model mid-turn, and an exception there costs the user the turn
 * on top of the file.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { restoreFromTaskTrash } from "./safe-delete.js";
import { findTrashEntry, type TrashTier } from "./trash-journal.js";
import { createLogger } from "./logger.js";

const logger = createLogger("trash-restore");

/** `tier` tells the caller WHERE the bytes came back from, which decides what
 *  else has to be true afterwards: only a task-tier restore may re-enroll the
 *  path as an agent artifact. Re-enrolling a user's own file would hand it the
 *  agent's delete protections and change how their own shell may treat it. */
export type RestoreResult = { restored: string; tier: TrashTier } | { error: string };

/** Move bytes back, refusing to clobber whatever lives there now. */
function putBack(src: string, target: string, tier: TrashTier): RestoreResult {
  if (existsSync(target)) {
    return { error: `Refusing to overwrite: ${target} already exists. Move or rename it first, then restore again.` };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    try {
      renameSync(src, target);
    } catch {
      cpSync(src, target, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    }
    logger.info(`restored ${target}`);
    return { restored: target, tier };
  } catch (e) {
    return { error: `Restore failed for ${target}: ${(e as Error).message}` };
  }
}

/** macOS puts the file in ~/.Trash under its own name, adding a numeric
 *  suffix on collision, so match the name and prefer the newest. */
function findInMacTrash(original: string): string | null {
  const dir = join(homedir(), ".Trash");
  if (!existsSync(dir)) return null;
  const base = basename(original);
  const stem = base.slice(0, base.length - extname(base).length);
  const ext = extname(base);
  const candidates = readdirSync(dir).filter((n) => n === base || (n.startsWith(stem) && n.endsWith(ext)));
  let newest: { path: string; at: number } | null = null;
  for (const name of candidates) {
    const p = join(dir, name);
    try {
      const at = statSync(p).mtimeMs;
      if (!newest || at > newest.at) newest = { path: p, at };
    } catch { /* vanished */ }
  }
  return newest?.path ?? null;
}

/** The freedesktop spec writes `Path=<original>` into
 *  ~/.local/share/Trash/info/<name>.trashinfo — an exact lookup, no guessing. */
function findInFreedesktopTrash(original: string): string | null {
  const root = join(homedir(), ".local", "share", "Trash");
  const info = join(root, "info");
  const files = join(root, "files");
  if (!existsSync(info)) return null;
  for (const name of readdirSync(info)) {
    if (!name.endsWith(".trashinfo")) continue;
    try {
      const body = readFileSync(join(info, name), "utf8");
      const line = /^Path=(.*)$/m.exec(body);
      if (!line) continue;
      if (decodeURIComponent(line[1].trim()) !== original) continue;
      const candidate = join(files, name.slice(0, -".trashinfo".length));
      if (existsSync(candidate)) return candidate;
    } catch { /* unreadable sidecar */ }
  }
  return null;
}

/** Windows keeps the original path in an $I sidecar and exposes a `undelete`
 *  verb through the shell. Ask the shell rather than parsing the binary $I
 *  format: the verb also repairs the bin's own index, which a manual move
 *  would leave stale. */
function restoreFromWindowsBin(original: string): RestoreResult {
  // The target is embedded as a single-quoted PowerShell literal, NOT passed
  // as an argument: `-Command` does not bind trailing arguments to $args (only
  // `-File` does), so an $args[0] version silently searched for the empty
  // string and reported every file missing. Doubling `'` is the escape for a
  // single-quoted literal, in which nothing else expands.
  const lit = `'${original.replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference='Stop'",
    `$target = ${lit}`,
    "$shell = New-Object -ComObject Shell.Application",
    "$bin = $shell.Namespace(10)",
    "$item = $null",
    // System.Recycle.DeletedFrom is the original FOLDER and is locale-stable;
    // the display column is a fallback because its index shifts across
    // Windows versions. Name + folder rebuilds the path the file came from.
    "foreach ($i in @($bin.Items())) {",
    "  $from = $i.ExtendedProperty('System.Recycle.DeletedFrom')",
    "  if (-not $from) { $from = $bin.GetDetailsOf($i,1) }",
    "  if (-not $from) { continue }",
    "  if ((Join-Path $from $i.Name) -ieq $target) { $item = $i; break }",
    "}",
    "if (-not $item) { Write-Output 'NOTFOUND'; exit 0 }",
    "$src = $item.Path",
    "try { $item.InvokeVerb('undelete') } catch { }",
    "for ($n=0; $n -lt 40 -and -not (Test-Path -LiteralPath $target); $n++) { Start-Sleep -Milliseconds 100 }",
    // Fallback: the verb name is localized on some builds and silently does
    // nothing. We already know both ends of the move, so do it ourselves and
    // drop the now-orphaned $I metadata sibling.
    "if (-not (Test-Path -LiteralPath $target)) {",
    "  if (Test-Path -LiteralPath $src) {",
    "    $dir = Split-Path -Parent $target",
    "    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }",
    "    Move-Item -LiteralPath $src -Destination $target -Force",
    "    $meta = Join-Path (Split-Path -Parent $src) (((Split-Path -Leaf $src) -replace '^\\$R','$I'))",
    "    if (Test-Path -LiteralPath $meta) { Remove-Item -LiteralPath $meta -Force -ErrorAction SilentlyContinue }",
    "  }",
    "}",
    "if (Test-Path -LiteralPath $target) { Write-Output 'OK' } else { Write-Output 'PENDING' }",
  ].join("\n");
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 30_000, windowsHide: true,
    }).trim();
    if (out.endsWith("NOTFOUND")) {
      return { error: `${original} is not in the Recycle Bin (it may have been emptied, or restored already).` };
    }
    return existsSync(original)
      ? { restored: original, tier: "os" }
      : { error: `The Recycle Bin reported ${out || "no result"} for ${original} and the file has not reappeared. Check the bin by hand.` };
  } catch (e) {
    return { error: `Could not restore ${original} from the Recycle Bin: ${(e as Error).message}` };
  }
}

/** Put a file back from whichever OS trash took it. */
export function restoreFromOsTrash(original: string): RestoreResult {
  if (existsSync(original)) return { error: `Nothing to restore: ${original} already exists.` };
  if (process.platform === "win32") return restoreFromWindowsBin(original);
  const found = process.platform === "darwin" ? findInMacTrash(original) : findInFreedesktopTrash(original);
  if (!found) {
    const where = process.platform === "darwin" ? "~/.Trash" : "~/.local/share/Trash";
    return { error: `${original} is not in ${where} (it may have been emptied, or restored already).` };
  }
  return putBack(found, original, "os");
}

/**
 * Restore `ref` — an absolute path, a bare basename, or a task-trash name —
 * from whichever tier the journal says holds it. Falls back to the task trash
 * when there is no journal entry, so deletions from before the journal existed
 * still restore exactly as they did.
 */
export function restoreDeleted(ref: string, opts: { sessionId?: string } = {}): RestoreResult {
  const fromTask = (sessionId: string, r: string): RestoreResult => {
    const out = restoreFromTaskTrash(sessionId, r);
    return "error" in out ? out : { restored: out.restored, tier: "task" };
  };
  const entry = findTrashEntry(ref, { kind: "file" });
  if (!entry) {
    // No journal line: either a deletion from before the journal existed, or a
    // ref only the task manifest can match (an in-trash name). Ask the tier
    // that owns those rather than reporting nothing.
    if (opts.sessionId) return fromTask(opts.sessionId, ref);
    return { error: `Nothing in the trash journal matches "${ref}". Nothing was restored.` };
  }
  switch (entry.tier) {
    case "task":
      // Hand the CALLER's ref through, not the journalled path: the task trash
      // matches on absolute path, basename AND in-trash name, and has its own
      // recovery behaviour for a corrupted manifest (where the original path
      // is lost and only a basename can match). The journal decides which tier
      // to ask; the tier keeps its own matching.
      return opts.sessionId
        ? fromTask(opts.sessionId, ref)
        : { error: `${entry.original} is in a task-scoped trash and needs the session that deleted it.` };
    case "lax":
      if (!entry.dest || !existsSync(entry.dest)) {
        return { error: `The trashed copy of ${entry.original} is gone (swept after the retention window). Nothing was restored.` };
      }
      return putBack(entry.dest, entry.original, "lax");
    case "os":
      return restoreFromOsTrash(entry.original);
    default:
      return { error: `${entry.original} was snapshotted as a config record, not a file — restore it through the tool that deleted it.` };
  }
}
