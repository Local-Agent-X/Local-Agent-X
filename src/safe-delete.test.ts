// App recycle bin. Proves a destructive op moves user data into ~/.lax/trash
// (recoverable) instead of perma-deleting it.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  moveToTrash,
  trashRecord,
  moveToTaskTrash,
  restoreFromTaskTrash,
  markTaskTrashScopeClosed,
  sweepOldTrash,
} from "./safe-delete.js";
import { deleteFileTool } from "./tools/read-write-tools.js";
import { recordTaskArtifact, clearTaskArtifacts } from "./data-lineage/task-artifacts.js";

let laxDir: string;
let workDir: string;
const prevEnv = process.env.LAX_DATA_DIR;

beforeEach(() => {
  laxDir = mkdtempSync(join(tmpdir(), "lax-trash-"));
  workDir = mkdtempSync(join(tmpdir(), "lax-work-"));
  process.env.LAX_DATA_DIR = laxDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  for (const d of [laxDir, workDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe("safe-delete recycle bin", () => {
  it("moves a file into ~/.lax/trash and removes it from the source", async () => {
    const f = join(workDir, "note.txt");
    writeFileSync(f, "important", "utf-8");
    const dest = await moveToTrash(f, "test");
    expect(dest).toBeTruthy();
    expect(existsSync(f)).toBe(false);                          // gone from source
    expect(existsSync(dest!)).toBe(true);                       // recoverable in trash
    expect(dest!.startsWith(join(laxDir, "trash"))).toBe(true); // under the recycle bin
  });

  it("moves a directory (an app) recursively", async () => {
    const app = join(workDir, "my-app");
    mkdirSync(app);
    writeFileSync(join(app, "index.html"), "<h1>hi</h1>", "utf-8");
    const dest = await moveToTrash(app, "app_delete");
    expect(existsSync(app)).toBe(false);
    expect(existsSync(join(dest!, "index.html"))).toBe(true);
  });

  it("returns null for a path that doesn't exist", async () => {
    expect(await moveToTrash(join(workDir, "missing"))).toBeNull();
  });

  it("snapshots a deleted config record (project/agent) as recoverable JSON", () => {
    const proj = { id: "proj-abc", name: "My Project", agentIds: ["a1", "a2"] };
    trashRecord(`project-${proj.id}`, proj);
    const trashDir = join(laxDir, "trash");
    const snaps = readdirSync(trashDir)
      .flatMap((d) => readdirSync(join(trashDir, d)).map((f) => join(trashDir, d, f)))
      .filter((f) => f.includes("project-proj-abc") && f.endsWith(".json"));
    expect(snaps.length).toBe(1);
    expect(JSON.parse(readFileSync(snaps[0], "utf-8"))).toEqual(proj);
  });
});

// ---- Task-scoped trash tier (tier 3) ----------------------------------------
// The verification invariant under test: a file the AGENT created during a
// task is never irrecoverably deleted mid-task — it lands in the task scope,
// restores byte-identical to its original path, and is only reclaimed after
// the scope closes (24h TTL) or, if never closed, by the 30-day retention.

describe("task-scoped trash tier", () => {
  it("moves an agent-created file into the task scope, records the original path in the manifest, and restores byte-identical", () => {
    const sid = "task-sess-restore";
    const f = join(workDir, "report.bin");
    const bytes = Buffer.from([0x4c, 0x41, 0x58, 0x00, 0xff, 0x7f, 0x0a]); // NUL + non-utf8 bytes
    writeFileSync(f, bytes);

    const dest = moveToTaskTrash(sid, f);
    expect(dest).toBeTruthy();
    expect(existsSync(f)).toBe(false);                                        // gone from source
    expect(dest!.startsWith(join(laxDir, "trash", "task", sid))).toBe(true);  // in the task scope

    const manifest = JSON.parse(
      readFileSync(join(laxDir, "trash", "task", sid, ".manifest.json"), "utf-8"),
    ) as Array<{ original: string; trashed: string }>;
    expect(manifest.map((e) => e.original)).toContain(f);                     // original path recorded

    const r = restoreFromTaskTrash(sid, "report.bin");                        // basename ref
    expect(r).toEqual({ restored: f });
    expect(readFileSync(f).equals(bytes)).toBe(true);                         // byte-identical
  });

  it("restore refuses to overwrite a file that now exists at the original path", () => {
    const sid = "task-sess-overwrite";
    const f = join(workDir, "notes.txt");
    writeFileSync(f, "agent version", "utf-8");
    const dest = moveToTaskTrash(sid, f);
    writeFileSync(f, "user re-created this", "utf-8");

    const r = restoreFromTaskTrash(sid, f);                                   // original-path ref
    expect(r).toEqual({ error: expect.stringContaining("Refusing to overwrite") });
    expect(readFileSync(f, "utf-8")).toBe("user re-created this");            // untouched
    expect(existsSync(dest!)).toBe(true);                                     // trashed copy still there
  });

  it("restore returns a clear error when nothing matches", () => {
    const r = restoreFromTaskTrash("task-sess-empty", "no-such-file.txt");
    expect(r).toEqual({ error: expect.stringContaining("No task-trash entry") });
  });

  it("sweep purges closed scopes past the 24h TTL; fresh-closed and open scopes survive", () => {
    const mkScope = (sid: string) => {
      const f = join(workDir, `${sid}.txt`);
      writeFileSync(f, sid, "utf-8");
      moveToTaskTrash(sid, f);
      return join(laxDir, "trash", "task", sid);
    };
    const oldClosed = mkScope("scope-closed-old");
    const freshClosed = mkScope("scope-closed-fresh");
    const open = mkScope("scope-open");
    markTaskTrashScopeClosed("scope-closed-old");
    markTaskTrashScopeClosed("scope-closed-fresh");
    // Backdate the old scope's marker past the TTL (the marker content is the clock).
    writeFileSync(join(oldClosed, ".closed"), JSON.stringify({ closedAt: Date.now() - 25 * 3_600_000 }), "utf-8");
    // Backdate the OPEN scope past the TTL too — closed-TTL must not apply to it.
    const h25 = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(open, h25, h25);

    sweepOldTrash();
    expect(existsSync(oldClosed)).toBe(false);  // closed + past TTL → purged
    expect(existsSync(freshClosed)).toBe(true); // closed but inside TTL → survives
    expect(existsSync(open)).toBe(true);        // never closed → TTL doesn't apply

    // An open scope still rides the ordinary 30-day retention.
    const d31 = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(open, d31, d31);
    sweepOldTrash();
    expect(existsSync(open)).toBe(false);
  });
});

// ---- delete_file routing ----------------------------------------------------
// Registry hit → task trash (result text is the restore_file contract);
// everything else → the OS-trash route, byte-identical to before the tier.

describe("delete_file routing", () => {
  it("routes an AGENT-CREATED file (task-artifact registry hit) to the task trash and pins the restore_file contract text", async () => {
    const sid = "route-sess-artifact";
    const f = join(workDir, "artifact.txt");
    writeFileSync(f, "agent made this", "utf-8");
    recordTaskArtifact(sid, f);
    try {
      const r = await deleteFileTool.execute({ path: f, _sessionId: sid });
      expect(r.isError).toBeFalsy();
      expect(String(r.content)).toBe(
        `Deleted ${f} (agent-created file — moved to task trash; restorable until this task ends via restore_file({ path: "${f}" })).`,
      );
      expect(existsSync(f)).toBe(false);
      expect(existsSync(join(laxDir, "trash", "task", sid))).toBe(true);      // task tier, not day-folder
      const back = restoreFromTaskTrash(sid, f);                              // the contract holds
      expect(back).toEqual({ restored: f });
      expect(readFileSync(f, "utf-8")).toBe("agent made this");
    } finally {
      clearTaskArtifacts(sid);
    }
  });

  it("keeps the OS-trash route for USER files (not in the registry) byte-identical", async () => {
    const f = join(workDir, "user-data.txt");
    writeFileSync(f, "user data", "utf-8");
    const r = await deleteFileTool.execute({ path: f, _sessionId: "route-sess-user" });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toMatch(/^Deleted .+ \(moved to .+ — recoverable\)$/);
    expect(existsSync(f)).toBe(false);
    expect(existsSync(join(laxDir, "trash", "task"))).toBe(false);            // never entered the task tier
  });

  it("missing sessionId keeps the existing OS-trash behavior (never throws)", async () => {
    const f = join(workDir, "no-session.txt");
    writeFileSync(f, "x", "utf-8");
    const r = await deleteFileTool.execute({ path: f });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("recoverable");
    expect(existsSync(f)).toBe(false);
  });
});

// ---- reopen + manifest recovery (skeptic rework pins) -----------------------
// F1: a stale-closed scope receiving NEW trash must never be purged by the
// self-invoked sweep — new activity re-opens the scope. Plus: a null return
// writes nothing (TOCTOU honesty upstream), and a corrupt manifest never
// orphans already-trashed bytes.

describe("task-scoped trash tier — reopen and manifest recovery", () => {
  it("new trash activity RE-OPENS a stale-closed scope instead of self-purging it", () => {
    const sid = "scope-reopen";
    const scope = join(laxDir, "trash", "task", sid);
    const f1 = join(workDir, "old-artifact.txt");
    writeFileSync(f1, "old", "utf-8");
    moveToTaskTrash(sid, f1);
    markTaskTrashScopeClosed(sid);
    // Scope closed >24h ago; the session then resumes under the same id.
    writeFileSync(join(scope, ".closed"), JSON.stringify({ closedAt: Date.now() - 25 * 3_600_000 }), "utf-8");

    const f2 = join(workDir, "fresh-artifact.txt");
    writeFileSync(f2, "fresh bytes", "utf-8");
    const dest = moveToTaskTrash(sid, f2);
    expect(dest).toBeTruthy();
    expect(existsSync(dest!)).toBe(true);                   // the new file survived its own trash call
    expect(existsSync(join(scope, ".closed"))).toBe(false); // marker cleared — scope re-opened

    sweepOldTrash();                                        // a later sweep leaves the open scope alone
    expect(existsSync(scope)).toBe(true);
    expect(restoreFromTaskTrash(sid, "fresh-artifact.txt")).toEqual({ restored: f2 });
    expect(readFileSync(f2, "utf-8")).toBe("fresh bytes");

    markTaskTrashScopeClosed(sid);                          // re-closing later works normally
    expect(existsSync(join(scope, ".closed"))).toBe(true);
  });

  it("returns null and writes nothing when the source is already gone", () => {
    const r = moveToTaskTrash("task-sess-vanished", join(workDir, "never-existed.txt"));
    expect(r).toBeNull();
    expect(existsSync(join(laxDir, "trash", "task", "task-sess-vanished"))).toBe(false);
  });

  it("a corrupt manifest never orphans trashed bytes: entries are recovered from the listing, the next trash appends", () => {
    const sid = "task-sess-corrupt";
    const scope = join(laxDir, "trash", "task", sid);
    const a = join(workDir, "first.txt");
    writeFileSync(a, "first bytes", "utf-8");
    const destA = moveToTaskTrash(sid, a)!;
    writeFileSync(join(scope, ".manifest.json"), "{ not json", "utf-8"); // corrupt it

    const b = join(workDir, "second.txt");
    writeFileSync(b, "second bytes", "utf-8");
    moveToTaskTrash(sid, b);

    const manifest = JSON.parse(readFileSync(join(scope, ".manifest.json"), "utf-8")) as
      Array<{ original: string | null; trashed: string; recovered?: true }>;
    expect(manifest.find((e) => e.trashed === basename(destA))).toMatchObject({ original: null, recovered: true });
    expect(manifest.some((e) => e.original === b)).toBe(true); // exactly one entry for the incoming file
    expect(manifest.filter((e) => e.trashed.startsWith("second.txt")).length).toBe(1);

    // A recovered entry resolves by in-trash name / basename, but its original
    // path is gone — restoring needs an explicit destination, and the error
    // must TEACH the constraint: the destination's basename must match the
    // trashed file's, or the retry matches nothing.
    const noDest = restoreFromTaskTrash(sid, basename(destA));
    expect(noDest).toEqual({ error: expect.stringContaining("full destination path") });
    expect((noDest as { error: string }).error).toContain('basename must be "first.txt"');
    expect(restoreFromTaskTrash(sid, a)).toEqual({ restored: a });
    expect(readFileSync(a, "utf-8")).toBe("first bytes");
  });

  it("a valid-JSON garbage ARRAY manifest also triggers reconstruction — never a silent empty scope", () => {
    // Skeptic fixture: JSON.parse succeeds and Array.isArray is true, but no
    // element passes the shape filter. Pre-fix this read as "empty scope" and
    // API-orphaned the already-trashed bytes; it must reconstruct instead.
    const sid = "task-sess-garbage-array";
    const scope = join(laxDir, "trash", "task", sid);
    const f = join(workDir, "orphan-candidate.txt");
    writeFileSync(f, "still restorable", "utf-8");
    const dest = moveToTaskTrash(sid, f)!;
    writeFileSync(join(scope, ".manifest.json"), JSON.stringify(["garbage", 42]), "utf-8");

    // Recovered entry: original path lost (null), bytes findable by basename.
    const r = restoreFromTaskTrash(sid, f); // ref with a directory part = explicit destination
    expect(r).toEqual({ restored: f });
    expect(readFileSync(f, "utf-8")).toBe("still restorable");
    expect(existsSync(dest)).toBe(false);

    // Control: a genuinely EMPTY array stays an empty scope (no reconstruction
    // inventing entries out of the directory's dotfiles).
    writeFileSync(join(scope, ".manifest.json"), "[]", "utf-8");
    expect(restoreFromTaskTrash(sid, "anything.txt")).toEqual({ error: expect.stringContaining("No task-trash entry") });
  });
});
