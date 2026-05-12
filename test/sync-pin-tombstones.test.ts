/**
 * Pin tombstones — verify the write/clear/apply contract that stops
 * sync-pull from re-adding pins the user explicitly removed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pinTombstonePaths,
  tombstonePin,
  clearPinTombstone,
  listTombstonedPinNames,
  applyPinTombstones,
} from "../src/sync/pin-tombstones.js";

let dataDir: string;
let syncRepoDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pintomb-data-"));
  syncRepoDir = mkdtempSync(join(tmpdir(), "pintomb-sync-"));
});

afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(syncRepoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("tombstonePin", () => {
  it("writes to BOTH local and synced stores", () => {
    const paths = pinTombstonePaths(dataDir, syncRepoDir);
    tombstonePin(paths, "Mario To Do");
    expect(existsSync(paths.localFile)).toBe(true);
    const local = JSON.parse(readFileSync(paths.localFile, "utf-8"));
    expect(local).toHaveLength(1);
    expect(local[0].name).toBe("Mario To Do");
    expect(existsSync(join(paths.syncDir, "Mario_To_Do.json"))).toBe(true);
  });

  it("is idempotent — second call doesn't duplicate", () => {
    const paths = pinTombstonePaths(dataDir, syncRepoDir);
    tombstonePin(paths, "X");
    tombstonePin(paths, "X");
    const local = JSON.parse(readFileSync(paths.localFile, "utf-8"));
    expect(local).toHaveLength(1);
  });

  it("each unpin writes its own synced tombstone file", () => {
    const paths = pinTombstonePaths(dataDir, syncRepoDir);
    tombstonePin(paths, "A");
    tombstonePin(paths, "B");
    expect(existsSync(join(paths.syncDir, "A.json"))).toBe(true);
    expect(existsSync(join(paths.syncDir, "B.json"))).toBe(true);
  });
});

describe("clearPinTombstone (resurrection)", () => {
  it("removes from local AND synced stores", () => {
    const paths = pinTombstonePaths(dataDir, syncRepoDir);
    tombstonePin(paths, "X");
    expect(existsSync(join(paths.syncDir, "X.json"))).toBe(true);

    clearPinTombstone(paths, "X");
    const local = JSON.parse(readFileSync(paths.localFile, "utf-8"));
    expect(local).toHaveLength(0);
    expect(existsSync(join(paths.syncDir, "X.json"))).toBe(false);
  });

  it("clearing a non-existent tombstone is a no-op (doesn't throw)", () => {
    const paths = pinTombstonePaths(dataDir, syncRepoDir);
    expect(() => clearPinTombstone(paths, "NeverTombstoned")).not.toThrow();
  });
});

describe("listTombstonedPinNames", () => {
  it("returns empty set when no tombstones exist", () => {
    const paths = pinTombstonePaths(dataDir, syncRepoDir);
    expect(listTombstonedPinNames(paths).size).toBe(0);
  });

  it("returns the union of local + synced names", () => {
    const paths = pinTombstonePaths(dataDir, syncRepoDir);
    tombstonePin(paths, "A");
    tombstonePin(paths, "B");
    const names = listTombstonedPinNames(paths);
    expect(names.has("A")).toBe(true);
    expect(names.has("B")).toBe(true);
    expect(names.size).toBe(2);
  });
});

describe("applyPinTombstones (the filter)", () => {
  it("drops pins whose name is in the tombstone set", () => {
    const remote = [
      { name: "Mario To Do", icon: "🍄", url: "/apps/mario/" },
      { name: "Dino", icon: "🦖", url: "/apps/dino/" },
      { name: "Funding Scanner", icon: "💰", url: "/apps/funding/" },
    ];
    const filtered = applyPinTombstones(remote, new Set(["Mario To Do", "Dino"]));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("Funding Scanner");
  });

  it("returns the input array unchanged when tombstone set is empty", () => {
    const remote = [{ name: "A", url: "/apps/a/" }];
    expect(applyPinTombstones(remote, new Set())).toEqual(remote);
  });
});

describe("end-to-end roaming scenario", () => {
  it("user unpins on this machine → next pull from remote (still has pin) drops it", () => {
    const paths = pinTombstonePaths(dataDir, syncRepoDir);
    // Step 1: user unpins "Mario" here.
    tombstonePin(paths, "Mario");
    // Step 2: remote pull-files reads the remote's sidebar-pins.json (other
    // machine still has Mario pinned) and filters through local tombstones.
    const remotePins = [{ name: "Mario", icon: "🍄", url: "/apps/mario/" }];
    const tombstoned = listTombstonedPinNames(paths);
    const result = applyPinTombstones(remotePins, tombstoned);
    expect(result).toHaveLength(0); // Mario stays unpinned, even though remote has it.
  });

  it("user re-pins after tombstoning → filter no longer drops it", () => {
    const paths = pinTombstonePaths(dataDir, syncRepoDir);
    tombstonePin(paths, "Mario");
    // User changes their mind — re-pin.
    clearPinTombstone(paths, "Mario");

    const remotePins = [{ name: "Mario", icon: "🍄", url: "/apps/mario/" }];
    const tombstoned = listTombstonedPinNames(paths);
    const result = applyPinTombstones(remotePins, tombstoned);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Mario");
  });
});
