// Restoring what LAX deleted, from whichever tier holds it.
//
// The bug this closes: delete_file sent a USER's file to the OS Recycle Bin
// and restore_file could only reach the agent's own task trash, so the agent
// had a destructive action with no undo. Measured 2026-09-20 — a model deleted
// three client originals, was asked to put them back, and had to tell the user
// to open the Recycle Bin by hand.
//
// The OS tier is exercised for real against the platform bin in
// docs/harness/phase1-evidence (a committed test must not move files into the
// user's Recycle Bin). What is pinned here is the routing, the journal, and
// the property that a restore never quietly widens what the agent owns.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "lax-trash-restore-"));
process.env.LAX_DATA_DIR = DATA;

const { appendTrashJournal, findTrashEntry, listRestorable, readTrashJournal } = await import("./trash-journal.js");
const { restoreDeleted } = await import("./trash-restore.js");
const { moveToTaskTrash, trashRecord, readTrashRecord, listTrashRecords } = await import("./safe-delete.js");

const work = () => mkdtempSync(join(tmpdir(), "lax-trash-work-"));
const laxTrashDir = join(DATA, "trash", "2026-09-20");

/** A file already "in the ~/.lax trash", plus the journal line that says so. */
function seedLaxTrashed(name: string, body: string) {
  const home = work();
  const original = join(home, name);
  mkdirSync(laxTrashDir, { recursive: true });
  const dest = join(laxTrashDir, `${name}.${Date.now()}${Math.random().toString(36).slice(2, 6)}`);
  writeFileSync(dest, body);
  appendTrashJournal({ original, tier: "lax", dest, kind: "file" });
  return { original, dest };
}

beforeEach(() => {
  rmSync(join(DATA, "trash-journal.jsonl"), { force: true });
});

describe("trash journal", () => {
  it("records a deletion and finds it by absolute path or bare name", () => {
    const { original } = seedLaxTrashed("notes.md", "x");
    expect(findTrashEntry(original)?.tier).toBe("lax");
    expect(findTrashEntry("notes.md")?.original).toBe(original);
    expect(findTrashEntry("never-deleted.md")).toBeNull();
  });

  it("most recent delete of the same name wins", () => {
    const a = seedLaxTrashed("dup.md", "first");
    const b = seedLaxTrashed("dup.md", "second");
    expect(a.original).not.toBe(b.original);
    expect(findTrashEntry("dup.md")?.dest).toBe(b.dest);
  });

  it("survives a corrupt line instead of losing the whole journal", () => {
    seedLaxTrashed("good.md", "x");
    writeFileSync(join(DATA, "trash-journal.jsonl"), readFileSync(join(DATA, "trash-journal.jsonl"), "utf8") + "{not json\n");
    expect(readTrashJournal()).toHaveLength(1);
    expect(findTrashEntry("good.md")).not.toBeNull();
  });

  it("listRestorable hides what is already back and what has been swept", () => {
    const back = seedLaxTrashed("returned.md", "x");
    writeFileSync(back.original, "the user put it back");   // exists again
    const swept = seedLaxTrashed("swept.md", "x");
    rmSync(swept.dest, { force: true });                     // bytes gone
    const live = seedLaxTrashed("still-here.md", "x");
    const names = listRestorable({ kind: "file" }).map((e) => e.original);
    expect(names).toContain(live.original);
    expect(names).not.toContain(back.original);
    expect(names).not.toContain(swept.original);
  });
});

describe("restoreDeleted", () => {
  it("brings a file back from the ~/.lax trash tier, byte-identical", () => {
    const { original } = seedLaxTrashed("report.md", "the original bytes");
    const out = restoreDeleted(original);
    expect(out).toEqual({ restored: original, tier: "lax" });
    expect(readFileSync(original, "utf8")).toBe("the original bytes");
  });

  it("refuses to overwrite whatever lives at the path now", () => {
    const { original } = seedLaxTrashed("conflict.md", "trashed copy");
    writeFileSync(original, "a newer file with the same name");
    const out = restoreDeleted(original);
    expect("error" in out && out.error).toMatch(/Refusing to overwrite/);
    expect(readFileSync(original, "utf8")).toBe("a newer file with the same name");
  });

  it("says so plainly when the bytes were swept", () => {
    const { original, dest } = seedLaxTrashed("gone.md", "x");
    rmSync(dest, { force: true });
    const out = restoreDeleted(original);
    expect("error" in out && out.error).toMatch(/swept|gone/i);
  });

  it("routes a task-tier deletion back through the task trash, and reports that tier", () => {
    const home = work();
    const original = join(home, "agent-scratch.txt");
    writeFileSync(original, "agent output");
    moveToTaskTrash("sess-1", original);
    expect(existsSync(original)).toBe(false);
    const out = restoreDeleted(original, { sessionId: "sess-1" });
    expect(out).toEqual({ restored: original, tier: "task" });
    expect(readFileSync(original, "utf8")).toBe("agent output");
  });

  it("a task-tier file needs its session — without one it says which is missing", () => {
    const home = work();
    const original = join(home, "scoped.txt");
    writeFileSync(original, "x");
    moveToTaskTrash("sess-2", original);
    const out = restoreDeleted(original);
    expect("error" in out && out.error).toMatch(/task-scoped|session/i);
  });

  it("falls back to the task trash when there is no journal line at all", () => {
    // Deletions from before the journal existed must still restore exactly as
    // they did, so the change cannot strand anything already in the trash.
    const home = work();
    const original = join(home, "legacy.txt");
    writeFileSync(original, "pre-journal");
    moveToTaskTrash("sess-3", original);
    rmSync(join(DATA, "trash-journal.jsonl"), { force: true });
    const out = restoreDeleted(original, { sessionId: "sess-3" });
    expect(out).toEqual({ restored: original, tier: "task" });
  });

  it("names the thing it could not find rather than failing silently", () => {
    const out = restoreDeleted(join(work(), "never-existed.md"));
    expect("error" in out && out.error).toMatch(/Nothing in the trash journal/);
  });
});

describe("config-record snapshots are readable again", () => {
  it("round-trips a snapshot that used to be write-only", () => {
    // trashRecord has written these since projects could be deleted, and
    // nothing ever read one back: the bytes were on disk and no code could
    // name the file.
    trashRecord("project-abc", { project: { id: "abc", name: "Harborline" }, rosters: [] });
    const back = readTrashRecord<{ project: { id: string; name: string } }>("project-abc");
    expect(back?.project).toEqual({ id: "abc", name: "Harborline" });
    expect(listTrashRecords().map((r) => r.name)).toContain("project-abc");
  });

  it("returns null for a name never snapshotted, and the newest for a repeat", () => {
    expect(readTrashRecord("project-missing")).toBeNull();
    trashRecord("agent-x", { id: "x", name: "first" });
    trashRecord("agent-x", { id: "x", name: "second" });
    expect(readTrashRecord<{ name: string }>("agent-x")?.name).toBe("second");
  });

  it("a record is not a file: restoreDeleted refuses it with a pointer to the right route", () => {
    trashRecord("project-zzz", { project: { id: "zzz" } });
    const out = restoreDeleted("project-zzz");
    // findTrashEntry(kind:"file") skips record rows, so this reports "nothing
    // matches" rather than pretending a JSON snapshot is a deleted file.
    expect("error" in out).toBe(true);
  });
});
