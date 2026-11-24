// When the desktop app dies without quitting, the next start says so and
// leaves a report behind.
//
// On 2026-11-24 the main process failed fast (0xc0000409) while the owner was
// using it. LAX's own logs just stopped: no crash reporter was on, nothing
// recorded whether a run ended cleanly, and the only trace was a Windows Error
// Reporting dump nobody was pointed at. Three pieces, all local (nothing is
// uploaded):
//
//   - Electron's crash reporter, started before the app is ready, writes a
//     minidump for any crashed process (main, renderer, GPU, utility) under
//     app.getPath("crashDumps").
//   - A run marker in the data dir: written "running" at start, "clean" on any
//     ordinary exit (quit, app.exit, relaunch). A start that finds it still
//     "running" knows the last run crashed.
//   - That start writes <data dir>/crash-reports/<when>.md: when the run began,
//     when its log went quiet, its last log lines, and every dump written since
//     it began (Electron's and Windows' own). The owner is told where it is.

import { app, crashReporter } from "electron";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { laxDataDir, logsDir } from "./contract/data-dir.js";

const MARKER_FILE = "desktop-run.json";
const LOG_FILE = "desktop-stdio.log";
const LOG_TAIL_LINES = 80;
const LOG_TAIL_BYTES = 64 * 1024;

export interface RunMarker {
  pid: number;
  startedAt: string;
  version: string;
  state: "running" | "clean";
}

export interface DumpFile { path: string; at: string; bytes: number }

/** Turn on crash dumps for every process of the app. Call before app ready. */
export function startCrashDumps(): void {
  try {
    crashReporter.start({ uploadToServer: false, globalExtra: { version: app.getVersion() } });
  } catch (e) {
    console.error(`[crash-report] crash dumps not started: ${(e as Error).message}`);
  }
}

export function readRunMarker(dataDir: string): RunMarker | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, MARKER_FILE), "utf-8")) as Partial<RunMarker>;
    return typeof raw.startedAt === "string" && (raw.state === "running" || raw.state === "clean") ? raw as RunMarker : null;
  } catch {
    return null;
  }
}

function writeRunMarker(dataDir: string, marker: RunMarker): void {
  writeFileSync(join(dataDir, MARKER_FILE), JSON.stringify(marker, null, 2));
}

/** Dump files in `dirs` (searched two levels down, as Crashpad nests them)
 *  written at or after `since`. */
export function dumpsSince(dirs: string[], since: Date): DumpFile[] {
  const found: DumpFile[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) { if (depth < 2) walk(path, depth + 1); continue; }
      if (/\.dmp$/i.test(name) && st.mtime >= since) found.push({ path, at: st.mtime.toISOString(), bytes: st.size });
    }
  };
  for (const dir of dirs) walk(dir, 0);
  return found.sort((a, b) => a.at.localeCompare(b.at));
}

/** The report a start writes about a run that never quit. Pure. */
export function buildCrashReport(a: { previous: RunMarker; foundAt: Date; logQuietAt: string | null; logTail: string; dumps: DumpFile[] }): string {
  const dumps = a.dumps.length
    ? a.dumps.map((d) => `- ${d.path} (${Math.round(d.bytes / 1024)} KB, written ${d.at})`).join("\n")
    : "- none found (the process may have been ended from outside, or the machine lost power)";
  return [
    `# Local Agent X closed without quitting`,
    ``,
    `- The run that crashed: pid ${a.previous.pid}, version ${a.previous.version}, started ${a.previous.startedAt}`,
    `- Its log went quiet at: ${a.logQuietAt ?? "unknown"}`,
    `- Noticed at the next start: ${a.foundAt.toISOString()}`,
    ``,
    `## Crash dumps written since it started`,
    ``,
    dumps,
    ``,
    `A dump says what failed. Open it with WinDbg (!analyze -v), or send it with this report.`,
    ``,
    `## The last lines it logged`,
    ``,
    "```",
    a.logTail.trimEnd(),
    "```",
    ``,
  ].join("\n");
}

function logTail(path: string): { tail: string; quietAt: string | null } {
  try {
    const st = statSync(path);
    const buf = readFileSync(path);
    const text = buf.subarray(Math.max(0, buf.length - LOG_TAIL_BYTES)).toString("utf-8");
    return { tail: text.split(/\r?\n/).slice(-LOG_TAIL_LINES).join("\n"), quietAt: st.mtime.toISOString() };
  } catch {
    return { tail: "(no log found)", quietAt: null };
  }
}

/** Where Windows itself puts a crashed program's dump (Windows Error Reporting). */
function windowsDumpDir(): string[] {
  return process.platform === "win32" && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "CrashDumps")] : [];
}

/**
 * Call once this instance holds the single-instance lock: a second launch
 * that quits must not touch the marker. Returns the path of a report written
 * about the previous run, or null when it ended cleanly (or never ran).
 */
export function noteRunStart(dataDir: string = laxDataDir()): string | null {
  let report: string | null = null;
  try {
    const previous = readRunMarker(dataDir);
    if (previous?.state === "running") {
      const foundAt = new Date();
      const { tail, quietAt } = logTail(join(logsDir(dataDir), LOG_FILE));
      const dumps = dumpsSince([app.getPath("crashDumps"), ...windowsDumpDir()], new Date(previous.startedAt));
      const dir = join(dataDir, "crash-reports");
      mkdirSync(dir, { recursive: true });
      report = join(dir, `${foundAt.toISOString().replace(/[:.]/g, "-")}.md`);
      writeFileSync(report, buildCrashReport({ previous, foundAt, logQuietAt: quietAt, logTail: tail, dumps }));
      console.error(`[crash-report] the last run (pid ${previous.pid}) closed without quitting; report: ${report}`);
    }
    const marker: RunMarker = { pid: process.pid, startedAt: new Date().toISOString(), version: app.getVersion(), state: "running" };
    writeRunMarker(dataDir, marker);
    // Every ordinary exit reaches here, app.exit and relaunch included; a
    // crash does not, which is the point.
    process.on("exit", () => {
      try { writeRunMarker(dataDir, { ...marker, state: "clean" }); } catch { /* exiting; the next start will report a crash it cannot prove */ }
    });
  } catch (e) {
    console.error(`[crash-report] run marker not kept: ${(e as Error).message}`);
  }
  return report;
}

/** Log a child process that died (GPU, utility, renderer) without taking the app down. */
export function watchChildProcesses(): void {
  app.on("child-process-gone", (_event, details) => {
    console.error(`[crash-report] ${details.type} process gone: ${details.reason} (exit ${details.exitCode})${details.name ? ` ${details.name}` : ""}`);
  });
}
