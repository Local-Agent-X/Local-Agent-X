import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, utimesSync, writeFileSync,
} from "node:fs";
import { _setDurableJsonlLockHookForTests, updateDurableJsonl } from "../src/persistence/durable-jsonl.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = resolve("test/fixtures/durable-jsonl-lock-worker.ts");
let root: string;
let gate: string;
let path: string;

beforeEach(() => {
  root = join(tmpdir(), `jsonl-race-${process.pid}-${Date.now()}`);
  gate = join(root, "gate");
  path = join(root, "events.jsonl");
  mkdirSync(gate, { recursive: true });
  const lock = `${path}.lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, "dead-token"), JSON.stringify({ pid: 99_999_999 }));
  const stale = new Date(Date.now() - 10_000);
  utimesSync(lock, stale, stale);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function start(id: string): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(process.execPath, ["--import=tsx", fixture, path, id, gate], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
  });
  const done = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  return { child, done };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

describe("durable JSONL lock reclamation", () => {
  it("two reclaimers never delete the replacement owner's live token", async () => {
    const a = start("a");
    const b = start("b");
    await waitFor(() => existsSync(join(gate, "ready-a")) && existsSync(join(gate, "ready-b")), "ready");
    writeFileSync(join(gate, "go"), "go");
    await waitFor(() => existsSync(join(gate, "acquired-a")) || existsSync(join(gate, "acquired-b")), "acquired");
    const winner = existsSync(join(gate, "acquired-a")) ? a : b;
    const loser = winner === a ? b : a;
    expect(await loser.done).not.toBe(0);
    const lock = `${path}.lock`;
    expect(readdirSync(lock)).toHaveLength(1);
    writeFileSync(join(gate, "release"), "release");
    expect(await winner.done).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf-8")).id).toMatch(/a|b/);
  }, 20_000);

  // The CI failure (Windows, 2026-11-15): a lock made in place (mkdir, then
  // the token) stood empty for a moment, a reclaimer's rmdir removed it, and
  // two processes held the lock. The folder must appear already holding its
  // token, so no rmdir can ever remove a live lock.
  it("the lock folder appears only once its owner's token is inside", () => {
    const lock = `${path}.lock`;
    rmSync(lock, { recursive: true, force: true });
    const points: string[] = [];
    let visibleBeforeToken = false;
    let removedWhileHeld = false;
    _setDurableJsonlLockHookForTests((point) => {
      points.push(point);
      if (point === "before_publish") visibleBeforeToken = existsSync(lock);
      if (point === "after_acquire") {
        try { rmdirSync(lock); removedWhileHeld = true; } catch { /* holds its token */ }
      }
    });
    try {
      updateDurableJsonl(path, (v): v is { id: string } => !!v && typeof (v as { id?: unknown }).id === "string", () => ({ id: "solo" }));
    } finally { _setDurableJsonlLockHookForTests(null); }
    expect(points).toEqual(["before_publish", "after_acquire"]);
    expect(visibleBeforeToken).toBe(false);
    expect(removedWhileHeld).toBe(false);
    expect(readdirSync(root).filter((n) => n.startsWith("events.jsonl.lock"))).toEqual([]);
  });

  const isRow = (v: unknown): v is { id: string } => !!v && typeof (v as { id?: unknown }).id === "string";
  const freshLock = (owner: string): string => {
    const lock = `${path}.lock`;
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(join(lock, "owner-token"), owner);
    return lock;
  };

  // The wait for a lock is 500 ms and a lock was only reclaimed past 2 s, so a
  // write right after a killed writer failed with a lock timeout.
  it("a fresh lock whose owner process is gone is taken at once", () => {
    freshLock(JSON.stringify({ pid: 99_999_999, incarnation: "99999999:gone" }));
    updateDurableJsonl(path, isRow, () => ({ id: "after-a-kill" }));
    expect(JSON.parse(readFileSync(path, "utf-8")).id).toBe("after-a-kill");
  });

  it("a fresh lock held by a live process, or one whose owner cannot be read, is still waited out", () => {
    const lock = freshLock(JSON.stringify({ pid: process.pid }));
    expect(() => updateDurableJsonl(path, isRow, () => ({ id: "stolen" }))).toThrow(/lock timeout/);
    expect(readdirSync(lock)).toEqual(["owner-token"]);
    freshLock("");
    expect(() => updateDurableJsonl(path, isRow, () => ({ id: "stolen" }))).toThrow(/lock timeout/);
    expect(existsSync(path)).toBe(false);
  });
});
