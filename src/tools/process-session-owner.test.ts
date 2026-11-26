// A build worker's dev server and emulator outlived the worker by days,
// sitting in its folder (2026-11-26). What a run starts in the background is
// ended with the run, and nobody else's is touched.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killSession, killSessionsStartedBy, startSession, type ProcessSession } from "./process-session.js";

const node = process.platform === "win32" ? process.execPath.replace(/\\/g, "/") : process.execPath;
const STAY = `"${node}" -e "setInterval(()=>{},1000)"`;
const started: ProcessSession[] = [];
const dirs: string[] = [];

function start(owner: string | undefined): ProcessSession {
  const dir = mkdtempSync(join(tmpdir(), "lax-owned-proc-"));
  dirs.push(dir);
  const res = startSession(STAY, dir, undefined, owner);
  if ("error" in res) throw new Error(res.error);
  started.push(res.session);
  return res.session;
}
const ended = (s: ProcessSession, ms = 15_000) => Promise.race([s.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

afterEach(async () => {
  for (const s of started.splice(0)) { killSession(s); await ended(s, 5_000); }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* still held for a moment */ } }
});

describe("killSessionsStartedBy", () => {
  it("ends what that run started and still had running, and nothing another run or a chat started", async () => {
    const worker = `agent-worker-${Date.now().toString(36)}`;
    const mine = [start(worker), start(worker)];
    const anothers = start(`${worker}-other`);
    const unowned = start(undefined);

    expect(killSessionsStartedBy(worker)).toBe(2);
    for (const s of mine) expect(await ended(s)).toBe(true);
    expect(anothers.exitedAt).toBeNull();
    expect(unowned.exitedAt).toBeNull();
    // Nothing left of that run's to end.
    expect(killSessionsStartedBy(worker)).toBe(0);
  }, 60_000);
});
