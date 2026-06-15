import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { dataDirLockPort, probeLockHolder, acquireDataDirLock } from "./datadir-lock.js";

describe("dataDirLockPort", () => {
  it("is deterministic and below both OS ephemeral ranges (20000-29999)", () => {
    const p = dataDirLockPort("/home/x/.lax");
    expect(p).toBe(dataDirLockPort("/home/x/.lax"));
    expect(p).toBeGreaterThanOrEqual(20000);
    expect(p).toBeLessThan(30000);
  });

  it("maps different data-dirs to different ports", () => {
    expect(dataDirLockPort("/home/a/.lax")).not.toBe(dataDirLockPort("/home/b/.lax"));
  });
});

describe("acquireDataDirLock — one server per data-dir", () => {
  const held: Server[] = [];
  afterEach(async () => {
    for (const s of held) await new Promise<void>((r) => s.close(() => r()));
    held.length = 0;
    vi.restoreAllMocks();
  });

  it("first acquire holds the lock; a second on the SAME dir refuses with exit(75)", async () => {
    // Regression (2026-06-15): a force-killed server left a dead-pid pidfile,
    // so a second LAX server on the same ~/.lax booted anyway — N servers
    // shared one data-dir and pegged a core each. The data-dir lock must make
    // the second instance refuse instead.
    const dir = `/tmp/lax-lock-same-${process.pid}`;
    const first = await acquireDataDirLock(dir);
    expect(first).not.toBeNull();
    if (first) held.push(first);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((): never => undefined as never));
    // The refuse path calls process.exit (here mocked) and never resolves, so
    // fire-and-wait rather than await.
    void acquireDataDirLock(dir);
    await new Promise((r) => setTimeout(r, 300));
    expect(exitSpy).toHaveBeenCalledWith(75);
  });

  it("fails open (no exit) when the port is held by a NON-LAX listener", async () => {
    const dir = `/tmp/lax-lock-foreign-${process.pid}`;
    const port = dataDirLockPort(dir);
    const decoy = createServer((s) => s.end("not-a-lax-server\n"));
    await new Promise<void>((r) => decoy.listen(port, "127.0.0.1", () => r()));
    held.push(decoy);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((): never => undefined as never));
    const result = await acquireDataDirLock(dir);
    expect(result).toBeNull();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
