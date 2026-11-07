/**
 * GHSA-9mv6: the Linux cage protects only startup files that exist, so a caged
 * shell could create ~/.bash_profile beside ~/.profile and have it run at the
 * next login. The watch moves aside whatever the command created.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { watchMissingPersistence, type PersistenceFs } from "./created-persistence.js";

const HOME = join("/nonexistent-home-for-test", "u");
const at = (rel: string) => join(HOME, rel);
const NOW = () => new Date("2026-11-06T23:59:00.000Z");

function fakeFs(present: string[]): PersistenceFs & { files: Set<string>; renames: Array<[string, string]>; failRename?: boolean } {
  const files = new Set(present.map(at));
  const fs = {
    files,
    renames: [] as Array<[string, string]>,
    failRename: false,
    exists: (p: string) => files.has(p),
    rename: (from: string, to: string) => {
      if (fs.failRename) throw new Error("EBUSY");
      files.delete(from);
      files.add(to);
      fs.renames.push([from, to]);
    },
  };
  return fs;
}

describe("watchMissingPersistence", () => {
  it("moves aside a startup file the command created where none was before", () => {
    const fs = fakeFs([".profile"]);
    const watch = watchMissingPersistence(HOME, fs, NOW);
    fs.files.add(at(".bash_profile"));
    const moved = watch.settle();
    expect(moved).toEqual([{ path: at(".bash_profile"), movedTo: `${at(".bash_profile")}.lax-blocked-2026-11-06T23-59-00-000Z` }]);
    expect(fs.exists(at(".bash_profile"))).toBe(false);
  });

  it("covers a startup folder that did not exist (systemd user units)", () => {
    const fs = fakeFs([]);
    const watch = watchMissingPersistence(HOME, fs, NOW);
    fs.files.add(at(".config/systemd/user"));
    expect(watch.settle().map((m) => m.path)).toEqual([at(".config/systemd/user")]);
  });

  it("never touches one that existed before the command", () => {
    const fs = fakeFs([".profile", ".bashrc"]);
    watchMissingPersistence(HOME, fs, NOW).settle();
    expect(fs.renames).toEqual([]);
    expect(fs.exists(at(".bashrc"))).toBe(true);
  });

  it("does nothing when the command created nothing", () => {
    const fs = fakeFs([".profile"]);
    expect(watchMissingPersistence(HOME, fs, NOW).settle()).toEqual([]);
  });

  it("a move the system refuses is logged, not thrown into the command's exit", () => {
    const fs = fakeFs([]);
    const watch = watchMissingPersistence(HOME, fs, NOW);
    fs.files.add(at(".bash_profile"));
    fs.failRename = true;
    expect(watch.settle()).toEqual([]);
  });
});
