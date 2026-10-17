// Tee the server child's stdout/stderr to a real file. Electron's GUI-launched
// main-process console is /dev/null, so any crash-loop output is invisible
// unless it is persisted. The file is opened append so successive respawns
// accumulate (with a START marker so the latest boot is easy to find); when it
// cannot be opened the output still reaches the console.

import type { ChildProcess } from "child_process";
import { createWriteStream, mkdirSync } from "fs";
import { join } from "path";
import { logsDir } from "./contract/data-dir.js";

/** Wire the child's streams. `onStderr` sees every stderr chunk — the exit
 *  handler classifies a death from the tail it keeps. */
export function teeServerStdio(proc: ChildProcess, onStderr: (text: string) => void): void {
  let sink: ((text: string) => void) | null = null;
  try {
    mkdirSync(logsDir(), { recursive: true });
    const stream = createWriteStream(join(logsDir(), "desktop-stdio.log"), { flags: "a" });
    stream.write(`\n\n══ START boot pid=${proc.pid} at ${new Date().toISOString()} ══\n`);
    sink = (text) => stream.write(text);
  } catch {
    sink = null; // no log file this boot; the console still gets every line
  }
  proc.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    sink?.(text);
    const line = text.trim();
    if (line) console.log("[server]", line);
  });
  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    sink?.(text);
    onStderr(text);
    const line = text.trim();
    if (line) console.error("[server]", line);
  });
}
