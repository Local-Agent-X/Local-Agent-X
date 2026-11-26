// A worktree folder that would not delete, restart after restart, was the
// current directory of a program a build worker had left running there
// (an emulator, dev servers: 2026-11-26). These run the real thing: a real
// process sitting in a real folder, on the platform where that holds it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { endLeftoverProcessesIn, removeWorktreeFolder } from "./worktree-leftovers.js";

const windows = process.platform === "win32";
const STAY = "setInterval(()=>{},1000)";
const started: ChildProcess[] = [];
const pids: number[] = [];
const dirs: string[] = [];

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (test: () => boolean, ms = 10_000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return test();
};
const folder = (): string => { const d = mkdtempSync(join(tmpdir(), "lax-leftover-")); dirs.push(d); return d; };

/** A program running in `dir` whose starter has exited: what a worker's `server &` leaves. */
async function leftBehindIn(dir: string): Promise<number> {
  const starter = spawn(process.execPath, ["-e",
    `const c = require("node:child_process").spawn(process.execPath, ["-e", "${STAY}"], { cwd: ${JSON.stringify(dir)}, detached: true, stdio: "ignore", windowsHide: true }); c.unref(); console.log(c.pid);`,
  ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let out = "";
  starter.stdout.on("data", (d) => { out += d; });
  await new Promise((r) => starter.on("exit", r));
  const pid = Number(out.trim());
  pids.push(pid);
  expect(await until(() => alive(pid))).toBe(true);
  return pid;
}

/** A program running in `dir` that this test process started and still holds. */
function startedHereIn(dir: string): number {
  const child = spawn(process.execPath, ["-e", STAY], { cwd: dir, stdio: "ignore", windowsHide: true });
  started.push(child);
  pids.push(child.pid!);
  return child.pid!;
}

afterEach(async () => {
  for (const child of started.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 200));
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe.runIf(windows)("a folder held by what was left running in it", () => {
  it("ends a program whose starter is gone, and one this server started", async () => {
    const dir = folder();
    const orphan = await leftBehindIn(dir);
    const ours = startedHereIn(dir);
    const sweep = await endLeftoverProcessesIn(dir);
    // Each takes what it started with it (its console host), so more than the two may be listed.
    expect(sweep.ended.map((p) => p.pid)).toEqual(expect.arrayContaining([orphan, ours]));
    expect(sweep.kept).toEqual([]);
    expect(await until(() => !alive(orphan) && !alive(ours))).toBe(true);
  }, 60_000);

  // Whoever started it is still running and is not the server: the owner's own
  // terminal, opened in the folder. Named here by telling the sweep the server
  // is some other process.
  it("leaves a program a living program other than the server started, and says so", async () => {
    const dir = folder();
    const theirs = startedHereIn(dir);
    const sweep = await endLeftoverProcessesIn(dir, 4);
    expect(sweep.ended).toEqual([]);
    expect(sweep.kept.map((p) => p.pid)).toEqual([theirs]);
    expect(alive(theirs)).toBe(true);
  }, 60_000);

  it("touches nothing running anywhere else", async () => {
    const dir = folder();
    const elsewhere = await leftBehindIn(folder());
    expect(await endLeftoverProcessesIn(dir)).toEqual({ ended: [], kept: [] });
    expect(alive(elsewhere)).toBe(true);
  }, 60_000);

  it("the delete goes through once what held the folder is ended", async () => {
    const dir = folder();
    const orphan = await leftBehindIn(dir);
    const notes: string[] = [];
    const gaveUp: string[] = [];
    expect(await removeWorktreeFolder(dir, (r) => gaveUp.push(r), (n) => notes.push(n))).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(gaveUp).toEqual([]);
    expect(notes.join("\n")).toContain(`pid ${orphan}`);
  }, 60_000);
});

describe("a folder nothing holds", () => {
  it("is deleted without looking for anything", async () => {
    const dir = folder();
    expect(await removeWorktreeFolder(dir, () => { throw new Error("gave up"); })).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it.runIf(!windows)("nothing is looked for where a current directory does not hold a folder", async () => {
    expect(await endLeftoverProcessesIn(folder())).toEqual({ ended: [], kept: [] });
  });
});
