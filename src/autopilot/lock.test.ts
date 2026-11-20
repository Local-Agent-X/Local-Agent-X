// One autopilot per repo. The lock was taken by checking, then writing, so two
// starts that both found it stale could both hold it; and a holder whose pid
// Windows had given to another program blocked every later start.
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, readLock, releaseLock } from "./lock.js";
import { currentProcessIncarnation } from "../persistence/process-incarnation.js";
import { getLaxDir } from "../lax-data-dir.js";

afterEach(() => {
  const held = readLock();
  if (held) releaseLock(held.opId);
});

/** The lock file acquireLock wrote (one per repo under the data dir). */
function lockFile(): string {
  const dir = join(getLaxDir(), "autopilot");
  return join(dir, readdirSync(dir).find((f) => f.endsWith(".lock"))!);
}

describe("acquireLock", () => {
  it("takes a free lock and blocks a second start while the holder lives", () => {
    expect(acquireLock("op-1", "topic")).toBeNull();
    expect(readLock()).toMatchObject({ pid: process.pid, opId: "op-1", incarnation: currentProcessIncarnation() });
    expect(acquireLock("op-2", "topic")).toMatchObject({ opId: "op-1" });
  });

  it("reclaims a lock whose pid now belongs to a different process", () => {
    expect(acquireLock("op-old", "topic")).toBeNull();
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, incarnation: `${process.pid}:an-earlier-start`, opId: "op-old", topic: "t", startedAt: "" }));
    expect(acquireLock("op-new", "topic")).toBeNull();
    expect(readLock()?.opId).toBe("op-new");
  });

  it("reclaims a lock that cannot be read", () => {
    expect(acquireLock("op-a", "topic")).toBeNull();
    writeFileSync(lockFile(), "{ torn");
    expect(acquireLock("op-b", "topic")).toBeNull();
    expect(readLock()?.opId).toBe("op-b");
  });
});
