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
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
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
    // A genuinely live holder = a real acquire (tracked by the in-process nonce).
    expect(acquireGlobalSelfEditLock().acquired).toBe(true);
    expect(acquireGlobalSelfEditLock({ force: false }).acquired).toBe(false);
    const stolen = acquireGlobalSelfEditLock({ force: true });
    expect(stolen.acquired).toBe(true);
    releaseGlobalSelfEditLock();
  });

  it("reclaims a leaked same-pid lock immediately (crash-before-release in this process)", () => {
    // self_edit runs in-process, so a leaked lock's pid is THIS always-alive
    // server. The nonce bookkeeping knows no live run wrote this file, so it is
    // reclaimable at once — even with a RECENT startedAt.
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    expect(acquireGlobalSelfEditLock({ force: false }).acquired).toBe(true);
    releaseGlobalSelfEditLock();
  });

  it("never TTL-reclaims a lock this process is actively holding (AB-6: worst-case run outlives the TTL)", () => {
    expect(acquireGlobalSelfEditLock({ task: "long run" }).acquired).toBe(true);
    // Age the running lock far past any TTL, preserving its per-run nonce.
    const holder = JSON.parse(readFileSync(LOCK, "utf-8"));
    holder.startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    writeFileSync(LOCK, JSON.stringify(holder));
    // A second self_edit must still block — reclaiming here would put two runs
    // in the shared node_modules concurrently.
    expect(acquireGlobalSelfEditLock().acquired).toBe(false);
    expect(isSelfEditLockHeldByLiveProcess()).toBe(true);
    releaseGlobalSelfEditLock();
    expect(existsSync(LOCK)).toBe(false); // release still works on the aged lock
  });

  it("blocks on another live process's lock at ~28min (AB-6: TTL raised past worst-case run)", () => {
    // process.ppid = the live test runner parent — a live pid that is not ours.
    writeFileSync(LOCK, JSON.stringify({ pid: process.ppid, startedAt: new Date(Date.now() - 28 * 60_000).toISOString() }));
    expect(acquireGlobalSelfEditLock().acquired).toBe(false);
  });

  it("still TTL-reclaims another live process's lock once truly stale", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: process.ppid, startedAt: new Date(Date.now() - 60 * 60_000).toISOString() }));
    expect(acquireGlobalSelfEditLock().acquired).toBe(true);
    releaseGlobalSelfEditLock();
  });

  it("release is ownership-aware — won't delete a lock owned by another PID", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" }));
    releaseGlobalSelfEditLock();
    expect(existsSync(LOCK)).toBe(true); // not ours → left intact
  });

  it("release won't delete a same-pid lock it no longer owns (AB-6: per-run nonce, not pid)", () => {
    expect(acquireGlobalSelfEditLock().acquired).toBe(true);
    // Simulate a reclaimer's lock: SAME pid (self_edit runs in-process), new nonce.
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce: "reclaimer-run" }));
    releaseGlobalSelfEditLock();
    expect(existsSync(LOCK)).toBe(true); // a pid-only check would delete the reclaimer's lock
  });
});

describe("isSelfEditLockHeldByLiveProcess (boot-sweep guard)", () => {
  it("is false when no lock file exists", () => {
    expect(isSelfEditLockHeldByLiveProcess()).toBe(false);
  });

  it("is true while a live run in this process holds the lock", () => {
    expect(acquireGlobalSelfEditLock().acquired).toBe(true);
    expect(isSelfEditLockHeldByLiveProcess()).toBe(true);
    releaseGlobalSelfEditLock();
  });

  it("is true while another live process holds an in-TTL-window lock", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    expect(isSelfEditLockHeldByLiveProcess()).toBe(true);
  });

  it("is false for a stale lock whose holder PID is dead", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" }));
    expect(isSelfEditLockHeldByLiveProcess()).toBe(false);
  });

  it("is false for a leaked same-pid lock no live run wrote", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z" }));
    expect(isSelfEditLockHeldByLiveProcess()).toBe(false);
  });

  it("is false for another live process's lock held past the TTL", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: process.ppid, startedAt: new Date(Date.now() - 60 * 60_000).toISOString() }));
    expect(isSelfEditLockHeldByLiveProcess()).toBe(false);
  });

  it("is false for a corrupt lock file", () => {
    writeFileSync(LOCK, "{ not json");
    expect(isSelfEditLockHeldByLiveProcess()).toBe(false);
  });
});
