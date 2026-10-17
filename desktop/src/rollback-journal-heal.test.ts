import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { healWedgedRollbackJournal } from "./rollback-journal-heal.js";
import { ROLLBACK_DIR, ROLLBACK_JOURNAL_FILE } from "./contract/data-dir.js";
import { hash, journalManifest, type UpdateRollbackJournal } from "./contract/rollback-journal.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

function laxDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-heal-"));
  roots.push(dir);
  return dir;
}

function writeJournal(lax: string, value: unknown): string {
  const dir = join(lax, ROLLBACK_DIR);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "backup.bin"), "the backup of a file the update touched");
  writeFileSync(join(dir, ROLLBACK_JOURNAL_FILE), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

// A journal signed by the writer's rule (the commitment over the manifest),
// which is what the server's validator accepts: the heal must leave it alone.
// test/desktop-server-contract.test.ts holds the real server writer to the
// same validator.
function realJournal(lax: string): UpdateRollbackJournal {
  const identity = (path: string) => ({ path, real: path, dev: 1, ino: 2, birthtimeMs: 3 });
  const unsigned = {
    version: 1 as const, id: "real", status: "active" as const, installRoot: join(lax, "install"), stateRoot: lax,
    installBase: identity(join(lax, "install")), stateBase: identity(lax),
    previousVersion: "a".repeat(40), targetVersion: "b".repeat(40), entries: [], startedAt: "2026-08-01T00:00:00Z",
  };
  return { ...unsigned, manifestCommitment: hash(journalManifest(unsigned)) };
}

describe("healWedgedRollbackJournal", () => {
  it("moves a pre-schema legacy journal aside, backups included", () => {
    const lax = laxDir();
    // The exact 2026-07 shape: version 1, no installBase/manifestCommitment.
    const dir = writeJournal(lax, {
      version: 1, id: "legacy", status: "active", installRoot: "/whatever",
      previousVersion: "a".repeat(40), targetVersion: "b".repeat(40), entries: [], startedAt: "2026-07-20T00:00:00Z",
    });
    const archive = healWedgedRollbackJournal(lax);
    expect(archive).toMatch(/update-rollback-superseded[\\/]heal-\d+$/);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(archive!, "artifacts", "backup.bin"), "utf-8")).toContain("the backup");
  });

  it("moves an unparseable journal aside", () => {
    const lax = laxDir();
    const dir = writeJournal(lax, "{ not json");
    expect(healWedgedRollbackJournal(lax)).not.toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  // The writer's own validator decides: a journal createJournal signed is
  // current whatever fields it happens to carry, and one whose commitment was
  // edited is not — the heal used to guess by two field names and would have
  // kept the tampered one and (had the schema moved on) discarded the real one.
  it("LEAVES a journal the server's validator accepts untouched", () => {
    const lax = laxDir();
    const dir = writeJournal(lax, realJournal(lax));
    expect(healWedgedRollbackJournal(lax)).toBeNull();
    expect(existsSync(join(dir, ROLLBACK_JOURNAL_FILE))).toBe(true);
  });

  it("moves aside a structurally complete journal whose commitment does not sign it", () => {
    const lax = laxDir();
    const dir = writeJournal(lax, { ...realJournal(lax), manifestCommitment: "c".repeat(64) });
    expect(healWedgedRollbackJournal(lax)).not.toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it("is a no-op when there is no journal", () => {
    expect(healWedgedRollbackJournal(laxDir())).toBeNull();
  });

  it("never throws on a missing lax dir", () => {
    expect(healWedgedRollbackJournal(join(tmpdir(), "does-not-exist-" + "x".repeat(8)))).toBeNull();
  });
});
