/**
 * Project tombstones — verify the write/clear/apply contract that stops
 * sync-pull from re-adding projects the user explicitly deleted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectTombstonePaths,
  tombstoneProject,
  clearProjectTombstone,
  listTombstonedProjectIds,
  applyProjectTombstones,
} from "../src/sync/project-tombstones.js";

let dataDir: string;
let syncRepoDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "projtomb-data-"));
  syncRepoDir = mkdtempSync(join(tmpdir(), "projtomb-sync-"));
});

afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(syncRepoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("tombstoneProject", () => {
  it("writes to BOTH local and synced stores", () => {
    const paths = projectTombstonePaths(dataDir, syncRepoDir);
    tombstoneProject(paths, "proj-abc123", "Mygroomtime");
    expect(existsSync(paths.localFile)).toBe(true);
    const local = JSON.parse(readFileSync(paths.localFile, "utf-8"));
    expect(local).toHaveLength(1);
    expect(local[0].id).toBe("proj-abc123");
    expect(local[0].name).toBe("Mygroomtime");
    expect(existsSync(join(paths.syncDir, "proj-abc123.json"))).toBe(true);
  });

  it("is idempotent — second call doesn't duplicate", () => {
    const paths = projectTombstonePaths(dataDir, syncRepoDir);
    tombstoneProject(paths, "proj-x");
    tombstoneProject(paths, "proj-x");
    const local = JSON.parse(readFileSync(paths.localFile, "utf-8"));
    expect(local).toHaveLength(1);
  });
});

describe("clearProjectTombstone", () => {
  it("removes from local AND synced stores", () => {
    const paths = projectTombstonePaths(dataDir, syncRepoDir);
    tombstoneProject(paths, "proj-x");
    expect(existsSync(join(paths.syncDir, "proj-x.json"))).toBe(true);

    clearProjectTombstone(paths, "proj-x");
    const local = JSON.parse(readFileSync(paths.localFile, "utf-8"));
    expect(local).toHaveLength(0);
    expect(existsSync(join(paths.syncDir, "proj-x.json"))).toBe(false);
  });

  it("clearing a non-existent tombstone is a no-op (doesn't throw)", () => {
    const paths = projectTombstonePaths(dataDir, syncRepoDir);
    expect(() => clearProjectTombstone(paths, "proj-never")).not.toThrow();
  });
});

describe("applyProjectTombstones", () => {
  it("drops projects whose id is in the tombstone set", () => {
    const remote = [
      { id: "proj-a", name: "Mygroomtime" },
      { id: "proj-b", name: "Mario" },
      { id: "proj-c", name: "Funding" },
    ];
    const filtered = applyProjectTombstones(remote, new Set(["proj-a", "proj-b"]));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("proj-c");
  });

  it("returns the input array unchanged when tombstone set is empty", () => {
    const remote = [{ id: "proj-a" }];
    expect(applyProjectTombstones(remote, new Set())).toEqual(remote);
  });
});

describe("end-to-end roaming scenario", () => {
  it("user deletes proj on this machine → next pull from remote (still has it) drops it", () => {
    const paths = projectTombstonePaths(dataDir, syncRepoDir);
    tombstoneProject(paths, "proj-mario", "Mario");
    const remoteProjects = [{ id: "proj-mario", name: "Mario", agentIds: [] }];
    const tombstoned = listTombstonedProjectIds(paths);
    const result = applyProjectTombstones(remoteProjects, tombstoned);
    expect(result).toHaveLength(0);
  });
});
