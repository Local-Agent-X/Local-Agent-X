import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { relative, join } from "path";
import { homedir } from "os";

export const STATE_PATH = join(homedir(), ".lax", "reconcile-state.json");

// sha256 of an empty buffer — sha256SrcTree returns this when the walk
// finds zero .ts files (typically: projectRoot points at a directory that
// doesn't contain desktop/src). Hardcoded so the comparison is obvious at
// the call site below.
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function sha256File(path: string): string {
  if (!existsSync(path)) return "";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function sha256SrcTree(dirPath: string, projectRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = (p: string): void => {
    if (!existsSync(p)) return;
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === "dist") continue;
        walk(full);
      } else if (st.isFile() && name.endsWith(".ts")) {
        files.push(full);
      }
    }
  };
  walk(dirPath);
  files.sort();
  for (const f of files) {
    hash.update(relative(projectRoot, f).replace(/\\/g, "/"));
    hash.update("\0");
    // await an ASYNC read so this yields the event loop between files. Hashing
    // the whole src tree (~1200 .ts files) with readFileSync blocked the main
    // thread for tens of seconds on a cold disk (Defender scanning each read),
    // and because runReconcile runs before the first await in the boot path,
    // the splash window's ready-to-show couldn't fire — so the app showed
    // NOTHING and never auto-displayed (only a manual tray click, which calls
    // show() directly, surfaced it). Same hash bytes, just non-blocking.
    hash.update(await readFile(f));
    hash.update("\0");
  }
  return hash.digest("hex");
}
