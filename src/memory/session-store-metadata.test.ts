/**
 * SessionStore metadata cache — per-turn write amplification + durability.
 *
 * Regression: save() re-serialized EVERY session in the store (a
 * JSON.stringify over the whole metadata map plus an atomic tmp+rename) on
 * every single turn, so the per-turn metadata cost grew with the size of the
 * session archive (~3000 files observed in the wild). The cache is now a
 * snapshot plus an append-only journal: a save appends one row, and the
 * O(sessions) snapshot only happens on an amortized compaction.
 *
 * The other half of the contract is durability. Coalescing the write must NOT
 * open a window where a saved session's metadata lives only in memory — a
 * process that dies without running any shutdown path must still leave the
 * metadata on disk, which is what the "unclean exit" cases below pin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";
import type { Session } from "../types.js";

// `atomicWrites` counts every write through the canonical module — mocking it
// also covers memory/utils.js, which re-exports it (the path SessionStore
// uses). `failing` injects metadata-write failures on demand: real disks fail
// these for boring reasons (a Windows AV scanner or indexer holding the
// handle — the same EPERM/EBUSY class the atomic-rename retry exists for), and
// injection is how we reproduce that deterministically on every platform.
const { atomicWrites, failing } = vi.hoisted(() => ({
  atomicWrites: [] as string[],
  failing: { appendPath: null as string | null, snapshot: false, dropPath: null as string | null },
}));

vi.mock("../util/json-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/json-store.js")>();
  return {
    ...actual,
    atomicWriteFileSync: (...args: Parameters<typeof actual.atomicWriteFileSync>) => {
      atomicWrites.push(args[0]);
      if (failing.snapshot && args[0].endsWith(".metadata.json")) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${args[0]}'`), { code: "EPERM" });
      }
      return actual.atomicWriteFileSync(...args);
    },
  };
});

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    appendFileSync: ((path: Parameters<typeof actual.appendFileSync>[0], ...rest: unknown[]) => {
      if (failing.appendPath !== null && String(path) === failing.appendPath) {
        throw Object.assign(
          new Error(`EPERM: operation not permitted, open '${String(path)}'`),
          { code: "EPERM" },
        );
      }
      // @ts-expect-error — forward the exact args to the real impl.
      return actual.appendFileSync(path, ...rest);
    }) as typeof actual.appendFileSync,
    // `dropPath` makes a file undeletable AND untruncatable — a handle held
    // with FILE_SHARE_READ|WRITE but not DELETE, which is what a Windows AV
    // scanner or the search indexer does to a file that was just written.
    // node's rmSync defaults to maxRetries: 0, so it surfaces immediately.
    rmSync: ((path: Parameters<typeof actual.rmSync>[0], ...rest: unknown[]) => {
      if (failing.dropPath !== null && String(path) === failing.dropPath) {
        throw Object.assign(
          new Error(`EBUSY: resource busy or locked, unlink '${String(path)}'`),
          { code: "EBUSY" },
        );
      }
      // @ts-expect-error — forward the exact args to the real impl.
      return actual.rmSync(path, ...rest);
    }) as typeof actual.rmSync,
    writeFileSync: ((path: Parameters<typeof actual.writeFileSync>[0], ...rest: unknown[]) => {
      if (failing.dropPath !== null && String(path) === failing.dropPath) {
        throw Object.assign(
          new Error(`EBUSY: resource busy or locked, open '${String(path)}'`),
          { code: "EBUSY" },
        );
      }
      // @ts-expect-error — forward the exact args to the real impl.
      return actual.writeFileSync(path, ...rest);
    }) as typeof actual.writeFileSync,
  };
});

import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-session-metadata-"));
  atomicWrites.length = 0;
  failing.appendPath = null;
  failing.snapshot = false;
  failing.dropPath = null;
});

afterEach(() => {
  failing.dropPath = null; // the temp dir has to be removable again
  rmSync(dataDir, { recursive: true, force: true });
});

function makeSession(id: string, messageCount = 1): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: Array.from({ length: messageCount }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i} of ${id}`,
    })),
  };
}

/** Snapshot rewrites only — session .jsonl writes go through the same fn. */
function snapshotWrites(): string[] {
  return atomicWrites.filter((p) => p.endsWith(".metadata.json"));
}

/** Per-session log rewrites — one per save, through that same fn. */
function sessionLogWrites(): string[] {
  return atomicWrites.filter((p) => p.endsWith(".jsonl") && !p.endsWith(".metadata.jsonl"));
}

function journalPath(): string {
  return join(dataDir, "sessions", ".metadata.jsonl");
}

describe("SessionStore metadata cache — write amplification", () => {
  it("does not rewrite the whole-store snapshot on every save", () => {
    const store = new SessionStore(dataDir);
    for (let i = 0; i < 40; i++) store.save(makeSession(`seed-${i}`));

    atomicWrites.length = 0;
    for (let i = 0; i < 40; i++) store.save(makeSession(`seed-${i}`, 3));

    // The counter has to be LIVE or the zero below means nothing. memory/utils
    // used to define its OWN atomicWriteFileSync, so NOTHING SessionStore wrote
    // passed through the mocked canonical module and this assertion was
    // satisfied by a store doing 40 whole-store re-serializations. Each save
    // rewrites its session .jsonl through the same function, so seeing 40 of
    // those proves the mock is on the store's real write path.
    expect(sessionLogWrites()).toHaveLength(40);
    // Was one full re-serialization of all 40 sessions per save.
    expect(snapshotWrites()).toEqual([]);
    // ...and the cache is still right, so the saving isn't from dropped work.
    expect(store.list()).toHaveLength(40);
    expect(store.list().every((r) => r.messageCount === 3)).toBe(true);
  });

  it("compacts the journal into a snapshot once it outgrows the store", () => {
    const store = new SessionStore(dataDir);
    atomicWrites.length = 0;
    for (let i = 1; i <= 260; i++) store.save(makeSession("hot", i));

    // Amortized: one snapshot across 260 saves, not 260.
    expect(snapshotWrites().length).toBe(1);
    expect(existsSync(join(dataDir, "sessions", ".metadata.json"))).toBe(true);
    // The rows appended AFTER the snapshot are not lost by the compaction.
    expect(new SessionStore(dataDir).list()[0].messageCount).toBe(260);
  });
});

describe("SessionStore metadata cache — durability across an unclean exit", () => {
  it("a saved session's metadata is on disk before any shutdown runs", () => {
    const store = new SessionStore(dataDir);
    store.save(makeSession("alpha", 3));
    store.save(makeSession("beta", 1));
    store.save(makeSession("alpha", 7)); // later write wins

    // No flush, no shutdown hook, no dispose — the process is simply gone.
    const revived = new SessionStore(dataDir);

    expect(revived.list().map((r) => r.id).sort()).toEqual(["alpha", "beta"]);
    expect(revived.list().find((r) => r.id === "alpha")!.messageCount).toBe(7);
    expect(revived.list().find((r) => r.id === "beta")!.title).toBe("Session beta");
  });

  it("a delete survives an unclean exit — no resurrected session", () => {
    const store = new SessionStore(dataDir);
    store.save(makeSession("keep"));
    store.save(makeSession("drop"));
    store.delete("drop");

    const revived = new SessionStore(dataDir);

    expect(revived.list().map((r) => r.id)).toEqual(["keep"]);
  });

  it("a torn trailing journal line is dropped, earlier rows still load", () => {
    const store = new SessionStore(dataDir);
    store.save(makeSession("intact-a"));
    store.save(makeSession("intact-b"));
    // Simulate a crash part-way through an append.
    appendFileSync(journalPath(), '{"id":"half-writ', "utf-8");

    const revived = new SessionStore(dataDir);

    expect(revived.list().map((r) => r.id).sort()).toEqual(["intact-a", "intact-b"]);
  });

  // A torn line has no trailing newline, so the NEXT append concatenates onto
  // it and the two become one unparseable line — dropping the torn row takes
  // the brand-new session down with it. Reading past the tear is not enough;
  // the file has to be cut back to the last complete line.
  it("a torn trailing line does not swallow the next session saved after it", () => {
    const store = new SessionStore(dataDir);
    store.save(makeSession("intact-a"));
    store.save(makeSession("intact-b"));
    appendFileSync(journalPath(), '{"id":"half-writ', "utf-8");

    // Restart over the torn journal, then start a brand-new chat.
    const revived = new SessionStore(dataDir);
    revived.save(makeSession("charlie", 4));

    const again = new SessionStore(dataDir);
    expect(again.list().map((r) => r.id).sort()).toEqual(["charlie", "intact-a", "intact-b"]);
    expect(again.list().find((r) => r.id === "charlie")!.messageCount).toBe(4);
  });
});

// The journal append is the ONLY per-save durability path, so dropping one on
// the floor loses a session's list row permanently — its .jsonl sits on disk
// with the whole conversation while the sessions list never shows it again.
// The whole-store snapshot this replaced was idempotent AND repeated, so a
// failed write healed on the next save; the append has to keep that property.
describe("SessionStore metadata cache — a failed journal write heals", () => {
  it("re-emits a row whose append failed with EPERM", () => {
    const store = new SessionStore(dataDir);
    atomicWrites.length = 0;
    store.save(makeSession("kept-a", 1));

    failing.appendPath = journalPath();
    store.save(makeSession("lost-b", 9));
    failing.appendPath = null;

    store.save(makeSession("kept-c", 1));
    store.save(makeSession("kept-a", 2));

    // In memory it was always right; the question is what survives a restart.
    const revived = new SessionStore(dataDir);
    expect(revived.list().map((r) => r.id).sort()).toEqual(["kept-a", "kept-c", "lost-b"]);
    expect(revived.list().find((r) => r.id === "lost-b")!.messageCount).toBe(9);
    expect(revived.list().find((r) => r.id === "kept-a")!.messageCount).toBe(2);

    // Healed by ONE snapshot, not by going back to a snapshot per save.
    expect(snapshotWrites()).toHaveLength(1);
  });

  it("keeps retrying across a total metadata-write outage", () => {
    const store = new SessionStore(dataDir);
    store.save(makeSession("before", 1));

    // Both paths are down: the append fails AND the snapshot fallback fails,
    // for two saves running. Nothing these saves do reaches disk.
    failing.appendPath = journalPath();
    failing.snapshot = true;
    store.save(makeSession("during-1", 5));
    store.save(makeSession("during-2", 6));

    // Disk comes back. The next save must carry the rows the outage dropped,
    // not just its own.
    failing.appendPath = null;
    failing.snapshot = false;
    store.save(makeSession("after", 7));

    const revived = new SessionStore(dataDir);
    expect(revived.list().map((r) => r.id).sort()).toEqual(["after", "before", "during-1", "during-2"]);
    expect(revived.list().find((r) => r.id === "during-1")!.messageCount).toBe(5);
    expect(existsSync(join(dataDir, "sessions", ".metadata.json"))).toBe(true);
  });
});

// A compaction is two writes: the snapshot lands, then the journal it
// supersedes is dropped. The second one can fail on its own (a held handle —
// rmSync does not retry), leaving a journal that is OLDER than the snapshot
// sitting next to it. Replaying those rows on the next boot undoes everything
// the snapshot recorded after them: metadata rolls backwards and, worst,
// deleted sessions come back as list rows whose .jsonl is gone. HEAD kept no
// journal and could not do this, so the journal has to be able to outlive a
// snapshot without costing correctness.
describe("SessionStore metadata cache — a superseded journal stuck on disk", () => {
  /** Compact once (snapshot OK, journal drop wedged), leaving the stale file. */
  function seedWedgedJournal(store: SessionStore): void {
    store.save(makeSession("doomed"));
    failing.dropPath = journalPath();
    for (let i = 1; i <= 205; i++) store.save(makeSession("hot", i));
  }

  it("a delete is not undone by the stale journal", () => {
    const store = new SessionStore(dataDir);
    seedWedgedJournal(store);

    store.delete("doomed");

    const revived = new SessionStore(dataDir);
    expect(revived.list().map((r) => r.id)).toEqual(["hot"]);
  });

  it("does not roll a session's metadata backwards", () => {
    const store = new SessionStore(dataDir);
    seedWedgedJournal(store);

    const revived = new SessionStore(dataDir);
    expect(revived.list().find((r) => r.id === "hot")!.messageCount).toBe(205);
  });

  it("keeps appending instead of pinning every later save to a full snapshot", () => {
    const store = new SessionStore(dataDir);
    seedWedgedJournal(store);

    atomicWrites.length = 0;
    for (let i = 206; i <= 225; i++) store.save(makeSession("hot", i));

    // Liveness: these saves really did go through the mocked writer.
    expect(sessionLogWrites()).toHaveLength(20);
    // An undeletable journal must not pin the store to O(all sessions) writes
    // for the rest of the process — the append path is still available.
    expect(snapshotWrites()).toEqual([]);
    expect(new SessionStore(dataDir).list()[0].messageCount).toBe(225);
  });
});
