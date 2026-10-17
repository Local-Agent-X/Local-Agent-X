// The server's pidfile: written by src/lifecycle.ts at boot, read by the
// desktop (desktop/src/server-probe.ts) to tell the server it spawned from an
// orphan of an earlier launch. The pid alone is not identity — PIDs recycle —
// so a reader pairs it with pid-probe.ts.

import { existsSync, readFileSync } from "node:fs";

export interface ServerPidFile {
  pid: number;
  /** The launcher's pid, when the server was spawned by one. */
  parentPid?: number;
  startedAt: string;
}

/** The pidfile at `path`, or null when absent or unreadable. */
export function readServerPidFile(path: string): ServerPidFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ServerPidFile> | null;
    if (!parsed || typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
    return parsed as ServerPidFile;
  } catch {
    return null;
  }
}
