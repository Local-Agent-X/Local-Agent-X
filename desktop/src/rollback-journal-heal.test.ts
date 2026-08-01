import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { healWedgedRollbackJournal } from "./rollback-journal-heal.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

function laxDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-heal-"));
  roots.push(dir);
  return dir;
}

function writeJournal(lax: string, value: unknown): string {
  const dir = join(lax, "update-rollback");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transaction.json"), JSON.stringify(value));
  return dir;
}

describe("healWedgedRollbackJournal", () => {
  it("removes a pre-schema legacy journal (missing manifestCommitment/installBase)", () => {
    const lax = laxDir();
    // The exact 2026-07 shape: version 1, no installBase/manifestCommitment.
    const dir = writeJournal(lax, {
      version: 1, id: "legacy", status: "active", installRoot: "/whatever",
      previousVersion: "a".repeat(40), targetVersion: "b".repeat(40), entries: [], startedAt: "2026-07-20T00:00:00Z",
    });
    expect(healWedgedRollbackJournal(lax)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("removes an unparseable journal", () => {
    const lax = laxDir();
    const dir = join(lax, "update-rollback");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transaction.json"), "{ not json");
    expect(healWedgedRollbackJournal(lax)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("LEAVES a structurally-current journal (real in-flight transaction) untouched", () => {
    const lax = laxDir();
    const dir = writeJournal(lax, {
      version: 1, id: "real", status: "active", installRoot: "/whatever",
      installBase: { path: "/whatever", real: "/whatever", dev: 1, ino: 2, birthtimeMs: 3 },
      manifestCommitment: "c".repeat(64),
      previousVersion: "a".repeat(40), targetVersion: "b".repeat(40), entries: [], startedAt: "2026-08-01T00:00:00Z",
    });
    expect(healWedgedRollbackJournal(lax)).toBe(false);
    expect(existsSync(join(dir, "transaction.json"))).toBe(true);
  });

  it("is a no-op when there is no journal", () => {
    const lax = laxDir();
    expect(healWedgedRollbackJournal(lax)).toBe(false);
  });

  it("never throws on a missing lax dir", () => {
    expect(healWedgedRollbackJournal(join(tmpdir(), "does-not-exist-" + "x".repeat(8)))).toBe(false);
  });
});
