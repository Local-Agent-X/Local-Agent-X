/**
 * The OS Trash / Recycle Bin tier of safe-delete.ts: hand an item to the
 * platform's own trash and report where it went.
 *
 * macOS and Linux take an item by moving it, or refuse and leave it in place.
 * Windows is the hazard: the Recycle Bin also moves what it takes, but an item
 * it will not hold — larger than the volume's bin, or on a volume with no bin
 * (removable, network) — is PERMANENTLY deleted when confirmations are
 * suppressed, and the call reports success either way. The bin's capacity is
 * not reliably readable up front, so the guarantee is built the other way
 * round: before the bin is asked, a second name for the bytes is created in
 * the app trash — a hard link when the file is on the app trash's volume
 * (free, no copy), a copy otherwise. After the call, the `$I` sidecar the bin
 * writes beside every item it holds is looked up by original path. Found: the
 * reserve is dropped and the `$R` path is recorded. Not found: the bin
 * destroyed its copy, and the reserve IS the trashed copy, journalled as the
 * app tier. A folder never goes to the Windows bin: reserving one means
 * copying the whole tree, and delete-folder.ts already sends folders to the
 * app trash for this same reason.
 */
import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, join, parse } from "node:path";
import { homedir } from "node:os";
import { desktopTrashItem } from "./desktop-bridge.js";
import { createLogger } from "./logger.js";

const logger = createLogger("os-trash");

export type OsTrashOutcome =
  /** The OS trash holds it; `dest` is the in-trash path when this side chose
   *  it (the macOS direct move) or could see it (the Windows `$R` file). */
  | { tier: "os"; dest: string | null }
  /** Windows: the bin would have destroyed it; the reserve holds the bytes. */
  | { tier: "lax"; dest: string }
  /** The item is still at its path; the caller falls back to the app trash. */
  | null;

/** The `$R` path of the newest Recycle Bin item whose sidecar names `original`. */
export type BinLocator = (original: string) => string | null;
let binLocator: BinLocator = findInWindowsBin;

/** Move `path` into the OS trash. `reserve` is the app-trash path the caller
 *  would otherwise use — on Windows it holds the bytes while the bin decides.
 *  Disabled under the test harness so suites never touch the developer's real
 *  Trash. Never throws: a null return means the item is still at `path`. */
export async function osTrash(path: string, reserve: string): Promise<OsTrashOutcome> {
  if (process.env.LAX_NO_NATIVE_TRASH) return null;
  if (process.platform !== "win32") return sendToOsTrash(path);
  try {
    if (statSync(path).isDirectory()) return null;
  } catch {
    return null;
  }
  if (!reserveBytes(path, reserve)) return null;
  const sent = await sendToOsTrash(path);
  if (!sent) {
    rmSync(reserve, { force: true });
    return null;
  }
  const inBin = binLocator(path);
  if (inBin) {
    rmSync(reserve, { force: true });
    return { tier: "os", dest: inBin };
  }
  logger.warn(`[trash] the Recycle Bin did not keep ${path}; the app trash copy at ${reserve} is the restore`);
  return { tier: "lax", dest: reserve };
}

// Best effort: an outcome only when the item actually left `path`. Preferred
// route is Electron main's shell.trashItem (real Put Back / Restore); absent
// outside the desktop app, so fall through to the platform's own facility.
async function sendToOsTrash(path: string): Promise<{ tier: "os"; dest: string | null } | null> {
  if (await desktopTrashItem(path)) return { tier: "os", dest: null };
  try {
    if (process.platform === "darwin") {
      // Direct move into ~/.Trash. macOS TCC blocks driving Finder via
      // osascript from a CLI/server process (Automation prompt), but WRITING
      // into ~/.Trash is an ordinary filesystem op — the item shows up in the
      // user's Trash, browsable and emptyable. (No Finder "Put Back" metadata;
      // the user drags it out or Empty-Trashes it.) Timestamp suffix avoids
      // clobbering an existing same-named item — the Trash listing is itself
      // TCC-protected, so we can't check for collisions, only avoid them.
      const dest = join(homedir(), ".Trash", `${basename(path)}.${Date.now()}`);
      renameSync(path, dest);
      return { tier: "os", dest };
    }
    if (process.platform === "win32") {
      // The path reaches PowerShell through the environment, never the script
      // text: PowerShell also closes a quoted string on U+2018-U+201B, so no
      // escaping of a path embedded as a literal is complete.
      execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command",
          `$p = $env:LAX_TRASH_PATH; Add-Type -AssemblyName Microsoft.VisualBasic; ` +
          `if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') } ` +
          `else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }`],
        { stdio: "ignore", timeout: 10_000, env: { ...process.env, LAX_TRASH_PATH: path } },
      );
    } else {
      execFileSync("gio", ["trash", "--", path], { stdio: "ignore", timeout: 10_000 });
    }
    return existsSync(path) ? null : { tier: "os", dest: null };
  } catch {
    return null; // no GUI session / tool missing / permission — caller falls back to ~/.lax/trash
  }
}

/** A second name for the file's bytes at `reserve`: a hard link when the
 *  volumes match, a copy otherwise. False when neither could be made — the
 *  caller then keeps the item out of the bin rather than risk it. */
function reserveBytes(path: string, reserve: string): boolean {
  try {
    mkdirSync(dirname(reserve), { recursive: true });
    try {
      linkSync(path, reserve);
    } catch {
      cpSync(path, reserve);
    }
    return true;
  } catch (e) {
    logger.warn(`[trash] could not reserve ${path} before the Recycle Bin: ${(e as Error).message}`);
    return false;
  }
}

/** The original path and deletion time a Recycle Bin `$I` sidecar records.
 *  Version 2 (Windows 10 and later) carries a length-prefixed UTF-16 path at
 *  offset 28; version 1 a fixed 520-byte field at offset 24. */
export function parseRecycleSidecar(buf: Buffer): { original: string; deletedAt: number } | null {
  if (buf.length < 28) return null;
  const version = Number(buf.readBigInt64LE(0));
  const deletedAt = Number(buf.readBigUInt64LE(16));
  let original: string;
  if (version === 2) {
    const end = 28 + buf.readInt32LE(24) * 2;
    if (end > buf.length) return null;
    original = buf.toString("utf16le", 28, end);
  } else if (version === 1) {
    original = buf.toString("utf16le", 24, Math.min(buf.length, 24 + 520));
  } else {
    return null;
  }
  const nul = original.indexOf("\0");
  return { original: nul === -1 ? original : original.slice(0, nul), deletedAt };
}

/** Find `original` in the Recycle Bin of its own volume: every `$I` sidecar
 *  under `<root>$Recycle.Bin/<sid>/` names the path it came from, and the `$R`
 *  file beside it holds the bytes. Other users' bins are unreadable and
 *  skipped; the newest sidecar wins when the same path was deleted twice. */
export function findInWindowsBin(original: string, binRoot = join(parse(original).root, "$Recycle.Bin")): string | null {
  const wanted = original.toLowerCase();
  const ext = extname(original).toLowerCase();
  let owners: string[];
  try {
    owners = readdirSync(binRoot);
  } catch {
    return null;
  }
  let best: { path: string; at: number } | null = null;
  for (const owner of owners) {
    const dir = join(binRoot, owner);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("$I") || extname(name).toLowerCase() !== ext) continue;
      let meta: ReturnType<typeof parseRecycleSidecar>;
      try {
        meta = parseRecycleSidecar(readFileSync(join(dir, name)));
      } catch {
        continue;
      }
      if (!meta || meta.original.toLowerCase() !== wanted) continue;
      const bytes = join(dir, `$R${name.slice(2)}`);
      if (existsSync(bytes) && (!best || meta.deletedAt > best.at)) best = { path: bytes, at: meta.deletedAt };
    }
  }
  return best?.path ?? null;
}

/** Test seam: stand in for the Recycle Bin lookup (null restores the real one). */
export function _setBinLocatorForTest(fn: BinLocator | null): void {
  binLocator = fn ?? findInWindowsBin;
}
