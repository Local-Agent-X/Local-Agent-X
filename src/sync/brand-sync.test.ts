/**
 * Brands sync with the other brain folders: their templates travel (the one
 * tree that carries Office files), and a brand deleted on one machine is
 * deleted on the others instead of coming back on the next pull.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAIN_DIRS, BRAIN_DIR_EXTENSIONS } from "./constants.js";
import { mirrorDir } from "./mirror.js";
import { applyTombstones, libraryTombstonePaths, writeTombstonesForDeletedApps } from "./tombstones.js";

function machine(root: string, name: string) {
  const dataDir = join(root, name);
  mkdirSync(join(dataDir, "brands"), { recursive: true });
  return dataDir;
}
function addBrand(dataDir: string, slug: string) {
  mkdirSync(join(dataDir, "brands", slug), { recursive: true });
  writeFileSync(join(dataDir, "brands", slug, "brand.json"), JSON.stringify({ name: slug }));
}

describe("brand sync", () => {
  it("is a brain folder, and carries a brand's templates but nothing else new", async () => {
    expect(BRAIN_DIRS).toContain("brands");
    const root = mkdtempSync(join(tmpdir(), "brand-sync-"));
    const a = machine(root, "a");
    addBrand(a, "acme");
    writeFileSync(join(a, "brands", "acme", "deck.potx"), "PK");
    writeFileSync(join(a, "brands", "acme", "run.exe"), "MZ");
    await mirrorDir(join(a, "brands"), join(root, "repo", "brands"), true, BRAIN_DIR_EXTENSIONS.brands);
    expect(existsSync(join(root, "repo", "brands", "acme", "deck.potx"))).toBe(true);
    expect(existsSync(join(root, "repo", "brands", "acme", "run.exe"))).toBe(false);
    // Elsewhere the default set still leaves Office files out.
    await mirrorDir(join(a, "brands"), join(root, "repo2"), true);
    expect(existsSync(join(root, "repo2", "acme", "deck.potx"))).toBe(false);
  });

  it("a brand deleted on one machine is deleted on the next, and pruned from the repo", () => {
    const root = mkdtempSync(join(tmpdir(), "brand-sync-"));
    const repo = join(root, "repo");
    const a = machine(root, "a"), b = machine(root, "b");
    for (const m of [a, b]) { addBrand(m, "acme"); addBrand(m, "keep"); }
    mkdirSync(join(repo, "brands", "acme"), { recursive: true });
    writeTombstonesForDeletedApps(libraryTombstonePaths(a, repo, "brands")); // baseline
    // Deleted on A.
    rmSync(join(a, "brands", "acme"), { recursive: true, force: true });
    writeTombstonesForDeletedApps(libraryTombstonePaths(a, repo, "brands"));
    expect(existsSync(join(repo, ".tombstones", "brands", "acme.json"))).toBe(true);
    expect(existsSync(join(repo, "brands", "acme"))).toBe(false);
    // B pulls.
    applyTombstones(libraryTombstonePaths(b, repo, "brands"));
    expect(existsSync(join(b, "brands", "acme"))).toBe(false);
    expect(existsSync(join(b, "brands", "keep"))).toBe(true);
    // App tombstones live one level up and are not touched by brands.
    expect(existsSync(join(repo, ".tombstones", "acme.json"))).toBe(false);
  });
});
