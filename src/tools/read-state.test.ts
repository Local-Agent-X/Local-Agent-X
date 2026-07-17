// Stale-read guard core. Proves the freshness tracker distinguishes unseen,
// fresh, and stale files per session — the logic the run-sandboxed guard uses
// to decide whether an edit may proceed or must re-read first.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, utimesSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CAN_CREATE_WINDOWS_JUNCTION } from "../symlink-capabilities.test-helper.js";
import {
  recordFileSeen,
  checkFreshness,
  forgetSessionReads,
  unchangedSinceSeen,
  sweepExternalChanges,
  resolveExternalChange,
  seenViewFromReadResult,
  _entryForTest,
} from "./read-state.js";

const statFault = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (path: Parameters<typeof actual.statSync>[0]) => {
      if (String(path) === statFault.path) {
        throw Object.assign(new Error("synthetic stat failure"), { code: "EACCES" });
      }
      return actual.statSync(path);
    },
  };
});

const dirs = new Set<string>();
afterEach(() => {
  statFault.path = "";
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  dirs.clear();
});

function tmpFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-rs-"));
  dirs.add(dir);
  const file = join(dir, name);
  writeFileSync(file, body, "utf-8");
  return file;
}

const JUNCTIONS_OK = process.platform === "win32" ? CAN_CREATE_WINDOWS_JUNCTION : true;

describe("read-state freshness", () => {
  it("reports unseen until the session records the file", () => {
    const file = tmpFile("a.txt", "hello\n");
    expect(checkFreshness("s1", file)).toBe("unseen");
    recordFileSeen("s1", file);
    expect(checkFreshness("s1", file)).toBe("ok");
  });

  it("reports stale once the file changes on disk after being seen", () => {
    const file = tmpFile("b.txt", "v1\n");
    recordFileSeen("s1", file);
    expect(checkFreshness("s1", file)).toBe("ok");
    writeFileSync(file, "v2\n", "utf-8");
    expect(checkFreshness("s1", file)).toBe("stale");
  });

  it("scopes tracking per session", () => {
    const file = tmpFile("c.txt", "x\n");
    recordFileSeen("s1", file);
    expect(checkFreshness("s1", file)).toBe("ok");
    expect(checkFreshness("s2", file)).toBe("unseen");
  });

  it("forgets a session on demand", () => {
    const file = tmpFile("d.txt", "x\n");
    recordFileSeen("s1", file);
    forgetSessionReads("s1");
    expect(checkFreshness("s1", file)).toBe("unseen");
  });

  // Regression (2026-07-02, food-truck chunk 2): read resolved to the workspace
  // junction spelling and the later edit to its target — same file, two keys —
  // so the stale-read guard blocked an edit on a file the worker had just read.
  it.skipIf(!JUNCTIONS_OK)("treats a file seen via a junction as the same file when edited via the real path", () => {
    const realDir = mkdtempSync(join(tmpdir(), "lax-rs-real-"));
    dirs.add(realDir);
    const realFile = join(realDir, "page.tsx");
    writeFileSync(realFile, "export default 1\n", "utf-8");

    // A junction dir pointing at realDir — the same inode, a different spelling.
    const linkDir = join(mkdtempSync(join(tmpdir(), "lax-rs-link-")), "ws");
    dirs.add(join(linkDir, ".."));
    symlinkSync(realDir, linkDir, "junction");
    const viaJunction = join(linkDir, "page.tsx");

    // Read via the junction spelling, edit-check via the real spelling.
    recordFileSeen("s1", viaJunction);
    expect(checkFreshness("s1", realFile)).toBe("ok");

    // And the reverse direction — read real, check via junction.
    forgetSessionReads("s1");
    recordFileSeen("s1", realFile);
    expect(checkFreshness("s1", viaJunction)).toBe("ok");

    // A genuine post-read change is still caught through either spelling.
    writeFileSync(realFile, "export default 2\n", "utf-8");
    expect(checkFreshness("s1", viaJunction)).toBe("stale");
  });
});

// Monotonic session counter — snapshot/dedup/sweep state is per session, so
// each test isolates itself instead of sharing "s1" like the freshness suite.
let seq = 0;
function sess(): string { return `rs-snap-${++seq}`; }

/** Write + force an mtime delta so mtime-prefiltered paths see a real bump. */
let mtimeBump = 0;
function writeBumped(file: string, body: string): void {
  writeFileSync(file, body, "utf-8");
  mtimeBump += 5_000;
  const bumped = new Date(Date.now() + mtimeBump);
  utimesSync(file, bumped, bumped);
}

describe("read-dedup (unchangedSinceSeen)", () => {
  it("dedups an unchanged full view and declines once content changes", () => {
    const s = sess();
    const file = tmpFile("dedup.txt", "v1\n");
    expect(unchangedSinceSeen(s, file)).toBe(false); // never seen
    recordFileSeen(s, file);
    expect(unchangedSinceSeen(s, file)).toBe(true);
    writeBumped(file, "v2\n");
    expect(unchangedSinceSeen(s, file)).toBe(false);
  });

  it("partial views never dedup, even when the bytes are unchanged", () => {
    const s = sess();
    const file = tmpFile("partial.txt", "line\n".repeat(50));
    recordFileSeen(s, file, { partial: true, range: { offset: 1, limit: 10 } });
    expect(unchangedSinceSeen(s, file)).toBe(false);
  });

  it("a ranged (mismatched-view) record declines dedup for a full re-read", () => {
    const s = sess();
    const file = tmpFile("ranged.txt", "line\n".repeat(50));
    // A range-clipped view is recorded partial by the phase layer — the next
    // full read must return real content, not a stub claiming equivalence.
    recordFileSeen(s, file, seenViewFromReadResult({ offset: 5, limit: 10 }, { truncated: true }));
    expect(unchangedSinceSeen(s, file)).toBe(false);
  });

  it("a moved mtime declines dedup even on identical bytes (prefilter, safe direction)", () => {
    const s = sess();
    const file = tmpFile("touch.txt", "same\n");
    recordFileSeen(s, file);
    // Atomic-save-style touch: mtime bumps, bytes identical. The dedup layer
    // declines (skips hashing) and the real re-read re-records — never a
    // wrong-way stub.
    const bumped = new Date(Date.now() + 60_000);
    utimesSync(file, bumped, bumped);
    expect(unchangedSinceSeen(s, file)).toBe(false);
    recordFileSeen(s, file);
    expect(unchangedSinceSeen(s, file)).toBe(true);
  });

  it("dedups an over-cap file via hash alone (snapshot skipped, hash kept)", () => {
    const s = sess();
    const file = tmpFile("big.txt", "x".repeat(300 * 1024));
    recordFileSeen(s, file);
    expect(_entryForTest(s, file)?.content).toBeUndefined(); // snapshot skipped
    expect(unchangedSinceSeen(s, file)).toBe(true); // hash still decides
  });

  // Mutation guard: deleting the hash comparison from unchangedSinceSeen
  // (leaving mtime-only dedup) must fail THIS test. Every other dedup test
  // bumps mtime alongside content, so mtime-only dedup passes them — this one
  // changes the bytes while pinning the mtime to the identical value, proving
  // the hash is the decider and mtime only ever a prefilter.
  it("identical mtime with DIFFERENT bytes never dedups — the hash is the decider", () => {
    const s = sess();
    const file = tmpFile("mutant.txt", "v1\n");
    // Whole-second timestamp so both utimes calls land on the exact same
    // mtimeMs across filesystems with different sub-second granularity.
    const pinned = new Date(Math.floor((Date.now() + 120_000) / 1000) * 1000);
    utimesSync(file, pinned, pinned);
    recordFileSeen(s, file);
    expect(_entryForTest(s, file)?.mtimeMs).toBe(pinned.getTime());
    expect(unchangedSinceSeen(s, file)).toBe(true);

    writeFileSync(file, "v2\n", "utf-8");
    utimesSync(file, pinned, pinned); // pin the mtime BACK: bytes changed, mtime identical
    expect(unchangedSinceSeen(s, file)).toBe(false);
  });

  it("a redacted view records hash-only state: no snapshot, never dedups", () => {
    const s = sess();
    const file = tmpFile("secret.env", "TOKEN=hunter2\n");
    recordFileSeen(s, file, { partial: false, redacted: true });
    const entry = _entryForTest(s, file);
    expect(entry?.content).toBeUndefined(); // the model never saw these bytes
    expect(entry?.partial).toBe(true);
    expect(entry?.hash).toBeTruthy(); // edit gate / change detection still work
    expect(unchangedSinceSeen(s, file)).toBe(false); // a placeholder is not a current view
  });
});

describe("snapshot LRU bound", () => {
  it("caps content snapshots per session but never evicts the edit-gate hash", () => {
    const s = sess();
    const dir = mkdtempSync(join(tmpdir(), "lax-rs-lru-"));
    dirs.add(dir);
    const files: string[] = [];
    for (let i = 0; i < 70; i++) {
      const f = join(dir, `f${i}.txt`);
      writeFileSync(f, `content ${i}\n`, "utf-8");
      files.push(f);
      recordFileSeen(s, f);
    }
    // Oldest entries lost their heavy snapshot, kept their hash — the
    // stale-read edit gate must never forget a file the session has seen.
    expect(_entryForTest(s, files[0])?.content).toBeUndefined();
    expect(_entryForTest(s, files[0])?.hash).toBeTruthy();
    expect(checkFreshness(s, files[0])).toBe("ok");
    // Recent entries still hold snapshots, and the cap holds overall.
    expect(_entryForTest(s, files[69])?.content).toBeDefined();
    const holders = files.filter((f) => _entryForTest(s, f)?.content !== undefined);
    expect(holders.length).toBe(64);
  });
});

describe("external-change sweep", () => {
  it("reports a changed file with before/after and full-diff resolution adopts the baseline", () => {
    const s = sess();
    const file = tmpFile("swept.txt", "old content\n");
    recordFileSeen(s, file);
    writeBumped(file, "new content\n");
    const changes = sweepExternalChanges(s);
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBe("old content\n");
    expect(changes[0].after).toBe("new content\n");
    resolveExternalChange(s, changes[0], true); // model saw the whole diff
    expect(checkFreshness(s, file)).toBe("ok"); // baseline adopted
    expect(sweepExternalChanges(s)).toEqual([]); // never re-notifies
  });

  it("a truncated notice suppresses re-notify but keeps the edit gate stale", () => {
    const s = sess();
    const file = tmpFile("trunc.txt", "old content\n");
    recordFileSeen(s, file);
    writeBumped(file, "new content\n");
    const changes = sweepExternalChanges(s);
    expect(changes).toHaveLength(1);
    resolveExternalChange(s, changes[0], false); // diff was truncated/diff-less
    expect(sweepExternalChanges(s)).toEqual([]); // quiet now…
    expect(checkFreshness(s, file)).toBe("stale"); // …but an edit still re-reads
    // A FURTHER change re-notifies (new disk hash ≠ the notified one).
    writeBumped(file, "third content\n");
    expect(sweepExternalChanges(s)).toHaveLength(1);
  });

  it("a no-op rewrite (mtime bump, identical bytes) stays silent and adopts the mtime", () => {
    const s = sess();
    const file = tmpFile("noop.txt", "same\n");
    recordFileSeen(s, file);
    const bumped = new Date(Date.now() + 90_000);
    utimesSync(file, bumped, bumped);
    expect(sweepExternalChanges(s)).toEqual([]);
    // The adopted mtime keeps later sweeps on the cheap prefilter path.
    expect(_entryForTest(s, file)?.mtimeMs).toBe(bumped.getTime());
  });

  it("exempts files the current turn touched itself", () => {
    const s = sess();
    const file = tmpFile("mine.txt", "old\n");
    recordFileSeen(s, file);
    writeBumped(file, "new\n");
    expect(sweepExternalChanges(s, [file])).toEqual([]);
  });

  it("evicts only after two consecutive ENOENT sweeps; a restored file resets the count", () => {
    const s = sess();
    const file = tmpFile("gone.txt", "v1\n");
    recordFileSeen(s, file);

    // Transient miss (editor atomic-save race): one ENOENT sweep keeps the entry.
    rmSync(file);
    expect(sweepExternalChanges(s)).toEqual([]);
    expect(_entryForTest(s, file)?.missingSweeps).toBe(1);
    writeFileSync(file, "v1\n", "utf-8"); // same bytes reappear
    sweepExternalChanges(s);
    expect(_entryForTest(s, file)?.missingSweeps).toBe(0);
    expect(checkFreshness(s, file)).toBe("ok");

    // Definitively gone: two consecutive ENOENT sweeps evict.
    rmSync(file);
    sweepExternalChanges(s);
    sweepExternalChanges(s);
    expect(_entryForTest(s, file)).toBeUndefined();
    expect(checkFreshness(s, file)).toBe("unseen");
  });

  it("never evicts on a non-ENOENT stat error, no matter how many sweeps", () => {
    const s = sess();
    const file = tmpFile("stat-error.txt", "v1\n");
    recordFileSeen(s, file);
    statFault.path = realpathSync(file);
    for (let i = 0; i < 5; i++) expect(sweepExternalChanges(s)).toEqual([]);
    expect(_entryForTest(s, file)).toBeDefined();
  });

  it("a session with no tracked files sweeps to nothing", () => {
    expect(sweepExternalChanges(sess())).toEqual([]);
  });

  it("an external change to a redacted-read file is detected DIFF-LESS — the withheld bytes never become hunks", () => {
    const s = sess();
    const file = tmpFile("swept-secret.env", "TOKEN=oldsecret\n");
    recordFileSeen(s, file, { partial: false, redacted: true });
    writeBumped(file, "TOKEN=newsecret\n");
    const changes = sweepExternalChanges(s);
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBeUndefined(); // no cached secret to diff from
    expect(changes[0].after).toBeUndefined(); // and no new secret shipped out
    // Diff-less notices resolve without adopting: the edit gate still forces
    // a real (re-redacted) read before any edit.
    resolveExternalChange(s, changes[0], false);
    expect(checkFreshness(s, file)).toBe("stale");
    expect(sweepExternalChanges(s)).toEqual([]);
  });
});

describe("seenViewFromReadResult", () => {
  it("maps truncated/screened metadata to a partial view and captures the range", () => {
    expect(seenViewFromReadResult({}, undefined)).toMatchObject({ partial: false, redacted: false });
    expect(seenViewFromReadResult({}, { truncated: true })).toMatchObject({ partial: true });
    expect(seenViewFromReadResult({}, { screened: true })).toMatchObject({ partial: true });
    expect(seenViewFromReadResult({ offset: 10, limit: 20 }, { truncated: true })).toMatchObject({
      partial: true,
      range: { offset: 10, limit: 20 },
    });
  });

  it("maps a data-lineage redaction stub to a redacted, partial view", () => {
    expect(seenViewFromReadResult({}, { layer: "data-lineage", redacted: true })).toMatchObject({
      partial: true,
      redacted: true,
    });
  });
});
