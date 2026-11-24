// A desktop run that dies without quitting is reported by the next start.
// On 2026-11-24 the main process failed fast and LAX's own logs just stopped:
// nothing recorded whether the run ended cleanly, and nobody was pointed at
// the dump Windows wrote.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ crashDumps: "" }));
vi.mock("electron", () => ({
  app: { getVersion: () => "0.5.13", getPath: () => fake.crashDumps, on: vi.fn() },
  crashReporter: { start: vi.fn() },
}));

const { buildCrashReport, dumpsSince, noteRunStart, readRunMarker } = await import("./crash-report.js");

let root: string;
let exitHandlers: Array<() => void>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-crash-report-"));
  fake.crashDumps = join(root, "Crashpad");
  mkdirSync(join(fake.crashDumps, "reports"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  exitHandlers = [];
  vi.spyOn(process, "on").mockImplementation(((event: string, fn: () => void) => { if (event === "exit") exitHandlers.push(fn); return process; }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("the run marker", () => {
  it("a first start writes no report and marks the run as running; an ordinary exit marks it clean", () => {
    expect(noteRunStart(root)).toBeNull();
    expect(readRunMarker(root)?.state).toBe("running");
    exitHandlers.forEach((fn) => fn());
    expect(readRunMarker(root)?.state).toBe("clean");
    expect(noteRunStart(root)).toBeNull();
  });

  it("a start that finds the last run still running writes a report with its dumps and last log lines", () => {
    const started = new Date(Date.now() - 60_000);
    writeFileSync(join(root, "desktop-run.json"), JSON.stringify({ pid: 31336, startedAt: started.toISOString(), version: "0.5.13", state: "running" }));
    writeFileSync(join(root, "logs", "desktop-stdio.log"), "[browser.nav] navigate -> https://example.com/\n[sync] exported 8683 facts\n");
    const dump = join(fake.crashDumps, "reports", "a1b2.dmp");
    writeFileSync(dump, "MDMP");
    const old = join(fake.crashDumps, "reports", "older.dmp");
    writeFileSync(old, "MDMP");
    const before = new Date(started.getTime() - 3_600_000);
    utimesSync(old, before, before);

    const report = noteRunStart(root);
    expect(report).toMatch(/crash-reports[\\/].+\.md$/);
    const text = readFileSync(report!, "utf-8");
    expect(text).toContain("pid 31336, version 0.5.13");
    expect(text).toContain(dump);
    expect(text).not.toContain("older.dmp");
    expect(text).toContain("[sync] exported 8683 facts");
    expect(readRunMarker(root)).toMatchObject({ pid: process.pid, state: "running" });
  });
});

describe("buildCrashReport", () => {
  it("says when no dump was found, rather than nothing", () => {
    const text = buildCrashReport({
      previous: { pid: 1, startedAt: "2026-11-24T22:20:37.000Z", version: "0.5.13", state: "running" },
      foundAt: new Date("2026-11-24T23:20:00Z"), logQuietAt: "2026-11-24T23:08:44.000Z", logTail: "x", dumps: [],
    });
    expect(text).toContain("Its log went quiet at: 2026-11-24T23:08:44.000Z");
    expect(text).toContain("none found");
  });
});

describe("dumpsSince", () => {
  it("finds dumps a level or two down, newest last, and skips other files", () => {
    writeFileSync(join(fake.crashDumps, "reports", "b.dmp"), "x");
    writeFileSync(join(fake.crashDumps, "settings.dat"), "x");
    const found = dumpsSince([fake.crashDumps, join(root, "missing")], new Date(Date.now() - 60_000));
    expect(found.map((d) => d.path)).toEqual([join(fake.crashDumps, "reports", "b.dmp")]);
  });
});
