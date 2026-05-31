/**
 * Tests for the global (cross-process) self_edit lock.
 *
 * The lock serializes every self_edit on the machine (sandbox + bypass). It must
 * be atomic (no check-then-write race), reclaim stale locks whose holder PID is
 * dead, let the `_unsafe` rescue force-steal a live lock, and only release a lock
 * the current process still owns (so a force-displaced holder doesn't free the
 * new owner's lock).
 *
 * LAX_DATA_DIR is redirected to a temp dir BEFORE importing the module (the lock
 * path is resolved at module load) so the test never touches a live instance's
 * real ~/.lax lock.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "lax-lock-test-"));
process.env.LAX_DATA_DIR = DATA_DIR;
const LOCK = join(DATA_DIR, "self-edit-sandbox.lock");

const { acquireGlobalSelfEditLock, releaseGlobalSelfEditLock, isSelfEditLockHeldByLiveProcess } = await import("../src/self-edit/global-lock.js");

const DEAD_PID = 2147483646; // unlikely to exist → isPidAlive false

beforeEach(() => {
  try { rmSync(LOCK, { force: true }); } catch { /* ignore */ }
});

describe("global self_edit lock", () => {
  it("acquires when free, then blocks a second acquire (live self-held)", () => {
    expect(acquireGlobalSelfEditLock().acquired).toBe(true);
    const second = acquireGlobalSelfEditLock();
    expect(second.acquired).toBe(false);
    expect(second.holder?.pid).toBe(process.pid);
  });

  it("releases then re-acquires", () => {
    expect(acquireGlobalSelfEditLock().acquired).toBe(true);
    releaseGlobalSelfEditLock();
    expect(existsSync(LOCK)).toBe(false);
    expect(acquireGlobalSelfEditLock().acquired).toBe(true);
  });

  it("reclaims a stale lock whose holder PID is dead", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" }));
    const r = acquireGlobalSelfEditLock();
    expect(r.acquired).toBe(true);
  });

  it("reclaims a corrupt lock file", () => {
    writeFileSync(LOCK, "{ not json");
    expect(acquireGlobalSelfEditLock().acquired).toBe(true);
  });

  it("force-steals a live lock; non-force does not", () => {
    // A live holder = this process's own pid (isPidAlive true).
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z" }));
    expect(acquireGlobalSelfEditLock({ force: false }).acquired).toBe(false);
    const stolen = acquireGlobalSelfEditLock({ force: true });
    expect(stolen.acquired).toBe(true);
  });

  it("release is ownership-aware — won't delete a lock owned by another PID", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" }));
    releaseGlobalSelfEditLock();
    expect(existsSync(LOCK)).toBe(true); // not ours → left intact
  });
});

describe("isSelfEditLockHeldByLiveProcess (boot-sweep guard)", () => {
  it("is false when no lock file exists", () => {
    expect(isSelfEditLockHeldByLiveProcess()).toBe(false);
  });

  it("is true while a live process holds the lock", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z" }));
    expect(isSelfEditLockHeldByLiveProcess()).toBe(true);
  });

  it("is false for a stale lock whose holder PID is dead", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" }));
    expect(isSelfEditLockHeldByLiveProcess()).toBe(false);
  });

  it("is false for a corrupt lock file", () => {
    writeFileSync(LOCK, "{ not json");
    expect(isSelfEditLockHeldByLiveProcess()).toBe(false);
  });
});
