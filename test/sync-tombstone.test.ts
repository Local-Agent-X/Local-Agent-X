import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";

// We test the tombstone semantics by building a minimal harness that mirrors
// the AgentSync helpers without going through the full git/sync stack.
// Reason: the real class needs git, file watchers, config; that's all
// tangential to the tombstone correctness test we care about.

interface Tombstone { name: string; deletedAt: string; deletedBy: string }

function listWorkspaceApps(appsDir: string): string[] {
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir).filter(e => {
    try { return require("node:fs").statSync(join(appsDir, e)).isDirectory(); } catch { return false; }
  });
}

function writeTombstonesForDeletedApps(opts: {
  appsDir: string;
  snapshotFile: string;
  tombstonesDir: string;
  syncRepoAppsDir?: string;
}): { newTombstones: string[]; clearedTombstones: string[]; firstRun: boolean } {
  const current = new Set(listWorkspaceApps(opts.appsDir));
  if (!existsSync(opts.snapshotFile)) {
    mkdirSync(require("node:path").dirname(opts.snapshotFile), { recursive: true });
    writeFileSync(opts.snapshotFile, JSON.stringify([...current].sort(), null, 2));
    return { newTombstones: [], clearedTombstones: [], firstRun: true };
  }
  let last: string[] = [];
  try { last = JSON.parse(readFileSync(opts.snapshotFile, "utf-8")); } catch {}

  const cleared: string[] = [];
  if (existsSync(opts.tombstonesDir)) {
    for (const file of readdirSync(opts.tombstonesDir)) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -5);
      if (current.has(name)) {
        rmSync(join(opts.tombstonesDir, file), { force: true });
        cleared.push(name);
      }
    }
  }

  const deletedSinceLast = last.filter(name => !current.has(name));
  if (deletedSinceLast.length > 0 && !existsSync(opts.tombstonesDir)) mkdirSync(opts.tombstonesDir, { recursive: true });
  for (const name of deletedSinceLast) {
    const t: Tombstone = { name, deletedAt: new Date().toISOString(), deletedBy: hostname() };
    writeFileSync(join(opts.tombstonesDir, `${name}.json`), JSON.stringify(t, null, 2));
    if (opts.syncRepoAppsDir) {
      const dead = join(opts.syncRepoAppsDir, name);
      if (existsSync(dead)) rmSync(dead, { recursive: true, force: true });
    }
  }
  writeFileSync(opts.snapshotFile, JSON.stringify([...current].sort(), null, 2));
  return { newTombstones: deletedSinceLast, clearedTombstones: cleared, firstRun: false };
}

function applyTombstones(opts: { appsDir: string; tombstonesDir: string }): string[] {
  if (!existsSync(opts.tombstonesDir)) return [];
  if (!existsSync(opts.appsDir)) return [];
  const removed: string[] = [];
  for (const file of readdirSync(opts.tombstonesDir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    const localApp = join(opts.appsDir, name);
    if (existsSync(localApp)) {
      rmSync(localApp, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

let tmpRoot: string;
let appsDir: string;
let snapshotFile: string;
let tombstonesDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sync-tombstone-test-"));
  appsDir = join(tmpRoot, "workspace", "apps");
  snapshotFile = join(tmpRoot, "sync-state", "last-pushed-apps.json");
  tombstonesDir = join(tmpRoot, "sync-repo", ".tombstones");
  mkdirSync(appsDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function makeApp(name: string): void {
  mkdirSync(join(appsDir, name), { recursive: true });
  writeFileSync(join(appsDir, name, "index.html"), `<!-- ${name} -->`);
}

function removeApp(name: string): void {
  rmSync(join(appsDir, name), { recursive: true, force: true });
}

describe("tombstone push — first run", () => {
  it("first push initializes snapshot and writes ZERO tombstones (no retroactive deletes)", () => {
    makeApp("alpha"); makeApp("beta"); makeApp("gamma");
    const r = writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    expect(r.firstRun).toBe(true);
    expect(r.newTombstones).toHaveLength(0);
    // Snapshot should contain all 3 apps
    const snap = JSON.parse(readFileSync(snapshotFile, "utf-8"));
    expect(snap).toEqual(["alpha", "beta", "gamma"]);
    // No tombstones written
    expect(existsSync(tombstonesDir)).toBe(false);
  });
});

describe("tombstone push — detect deletions since last push", () => {
  it("writes a tombstone for an app present last push but missing now", () => {
    makeApp("alpha"); makeApp("beta");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir }); // baseline
    removeApp("beta");
    const r = writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    expect(r.firstRun).toBe(false);
    expect(r.newTombstones).toEqual(["beta"]);
    expect(existsSync(join(tombstonesDir, "beta.json"))).toBe(true);
    // Snapshot now reflects the deletion
    const snap = JSON.parse(readFileSync(snapshotFile, "utf-8"));
    expect(snap).toEqual(["alpha"]);
  });

  it("tombstone payload includes name + timestamp + machine identity", () => {
    makeApp("alpha");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    removeApp("alpha");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    const t: Tombstone = JSON.parse(readFileSync(join(tombstonesDir, "alpha.json"), "utf-8"));
    expect(t.name).toBe("alpha");
    expect(t.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t.deletedBy).toBe(hostname());
  });

  it("does NOT re-write the same tombstone if the app stays deleted across pushes", () => {
    makeApp("alpha"); makeApp("beta");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    removeApp("beta");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    const stat1 = require("node:fs").statSync(join(tombstonesDir, "beta.json"));
    // Second push with no new deletes — snapshot already excludes beta,
    // so the diff is empty and no re-write happens
    const r2 = writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    expect(r2.newTombstones).toHaveLength(0);
    const stat2 = require("node:fs").statSync(join(tombstonesDir, "beta.json"));
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });

  it("does NOT tombstone apps that were never in the snapshot (machine-only apps)", () => {
    // The bug fix. Snapshot has [alpha, beta]; current has [alpha] (beta
    // deleted) AND a brand-new gamma that was never in any prior snapshot.
    // Write happens for beta. gamma is just added and snapshot updates.
    // The original bug: gamma would have been deleted by the OTHER machine
    // because IT didn't have gamma. With tombstones, gamma never gets a
    // tombstone, so the other machine leaves its own gamma alone.
    makeApp("alpha"); makeApp("beta");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    removeApp("beta");
    makeApp("gamma");
    const r = writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    expect(r.newTombstones).toEqual(["beta"]);
    expect(existsSync(join(tombstonesDir, "gamma.json"))).toBe(false);
    expect(existsSync(join(tombstonesDir, "alpha.json"))).toBe(false);
  });
});

describe("tombstone pull — apply remote tombstones to local", () => {
  it("removes a local app when a tombstone for it exists", () => {
    makeApp("alpha"); makeApp("beta");
    mkdirSync(tombstonesDir, { recursive: true });
    writeFileSync(join(tombstonesDir, "beta.json"), JSON.stringify({
      name: "beta", deletedAt: new Date().toISOString(), deletedBy: "other-machine",
    }));
    const removed = applyTombstones({ appsDir, tombstonesDir });
    expect(removed).toEqual(["beta"]);
    expect(existsSync(join(appsDir, "beta"))).toBe(false);
    expect(existsSync(join(appsDir, "alpha"))).toBe(true);
  });

  it("is a no-op when the tombstoned app doesn't exist locally", () => {
    makeApp("alpha");
    mkdirSync(tombstonesDir, { recursive: true });
    writeFileSync(join(tombstonesDir, "ghost.json"), JSON.stringify({
      name: "ghost", deletedAt: new Date().toISOString(), deletedBy: "other-machine",
    }));
    const removed = applyTombstones({ appsDir, tombstonesDir });
    expect(removed).toHaveLength(0);
    expect(existsSync(join(appsDir, "alpha"))).toBe(true);
  });

  it("does NOT touch local apps that have no tombstone", () => {
    makeApp("alpha"); makeApp("beta"); makeApp("gamma");
    mkdirSync(tombstonesDir, { recursive: true });
    writeFileSync(join(tombstonesDir, "alpha.json"), JSON.stringify({
      name: "alpha", deletedAt: new Date().toISOString(), deletedBy: "other-machine",
    }));
    applyTombstones({ appsDir, tombstonesDir });
    // Only alpha was tombstoned — beta and gamma must survive
    expect(existsSync(join(appsDir, "alpha"))).toBe(false);
    expect(existsSync(join(appsDir, "beta"))).toBe(true);
    expect(existsSync(join(appsDir, "gamma"))).toBe(true);
  });

  it("is a safe no-op when tombstones dir doesn't exist", () => {
    makeApp("alpha");
    expect(() => applyTombstones({ appsDir, tombstonesDir })).not.toThrow();
    expect(existsSync(join(appsDir, "alpha"))).toBe(true);
  });

  it("ignores non-.json entries in tombstones dir", () => {
    makeApp("alpha");
    mkdirSync(tombstonesDir, { recursive: true });
    writeFileSync(join(tombstonesDir, "README"), "not a tombstone");
    writeFileSync(join(tombstonesDir, "alpha.txt"), "wrong extension");
    const removed = applyTombstones({ appsDir, tombstonesDir });
    expect(removed).toHaveLength(0);
    expect(existsSync(join(appsDir, "alpha"))).toBe(true);
  });
});

describe("tombstone two-machine simulation", () => {
  // Most important test: replays the exact bug scenario the user hit.
  // Machine A has apps [alpha, beta]. Machine B has apps [alpha, gamma].
  // B pushes, then A pulls. Old code: A's beta gets deleted. New code:
  // A's beta survives because nothing tombstoned it.

  it("machine-only app survives a pull from a machine that never had it", () => {
    // === MACHINE A ===
    const aRoot = mkdtempSync(join(tmpdir(), "tomb-A-"));
    const aApps = join(aRoot, "workspace", "apps");
    const aSnap = join(aRoot, "sync-state", "last-pushed-apps.json");
    mkdirSync(join(aApps, "alpha"), { recursive: true });
    mkdirSync(join(aApps, "beta"), { recursive: true });

    // === MACHINE B ===
    const bRoot = mkdtempSync(join(tmpdir(), "tomb-B-"));
    const bApps = join(bRoot, "workspace", "apps");
    const bSnap = join(bRoot, "sync-state", "last-pushed-apps.json");
    mkdirSync(join(bApps, "alpha"), { recursive: true });
    mkdirSync(join(bApps, "gamma"), { recursive: true });

    // === SHARED SYNC REPO (simulates the git-backed sync-repo) ===
    const sharedSync = mkdtempSync(join(tmpdir(), "tomb-sync-"));
    const sharedTombstones = join(sharedSync, ".tombstones");

    try {
      // B pushes first — initial run, no tombstones written
      writeTombstonesForDeletedApps({ appsDir: bApps, snapshotFile: bSnap, tombstonesDir: sharedTombstones });
      // A pushes — also initial run, no tombstones written
      writeTombstonesForDeletedApps({ appsDir: aApps, snapshotFile: aSnap, tombstonesDir: sharedTombstones });

      // A pulls (applies tombstones from shared sync). No tombstones exist
      // → beta survives.
      applyTombstones({ appsDir: aApps, tombstonesDir: sharedTombstones });
      expect(existsSync(join(aApps, "beta"))).toBe(true);
      // alpha and gamma still on respective machines
      expect(existsSync(join(aApps, "alpha"))).toBe(true);
      expect(existsSync(join(bApps, "gamma"))).toBe(true);
    } finally {
      rmSync(aRoot, { recursive: true, force: true });
      rmSync(bRoot, { recursive: true, force: true });
      rmSync(sharedSync, { recursive: true, force: true });
    }
  });

  it("intentional deletion on A propagates to B (the feature still works)", () => {
    const aRoot = mkdtempSync(join(tmpdir(), "tomb-A2-"));
    const aApps = join(aRoot, "workspace", "apps");
    const aSnap = join(aRoot, "sync-state", "last-pushed-apps.json");
    mkdirSync(join(aApps, "alpha"), { recursive: true });
    mkdirSync(join(aApps, "obsolete"), { recursive: true });

    const bRoot = mkdtempSync(join(tmpdir(), "tomb-B2-"));
    const bApps = join(bRoot, "workspace", "apps");
    mkdirSync(join(bApps, "alpha"), { recursive: true });
    mkdirSync(join(bApps, "obsolete"), { recursive: true });
    mkdirSync(join(bApps, "machine-b-only"), { recursive: true });

    const sharedSync = mkdtempSync(join(tmpdir(), "tomb-sync2-"));
    const sharedTombstones = join(sharedSync, ".tombstones");

    try {
      // A's first push (baseline)
      writeTombstonesForDeletedApps({ appsDir: aApps, snapshotFile: aSnap, tombstonesDir: sharedTombstones });

      // A intentionally deletes 'obsolete' and pushes again
      rmSync(join(aApps, "obsolete"), { recursive: true });
      const r = writeTombstonesForDeletedApps({ appsDir: aApps, snapshotFile: aSnap, tombstonesDir: sharedTombstones });
      expect(r.newTombstones).toEqual(["obsolete"]);

      // B pulls + applies tombstones. obsolete should be gone, alpha + machine-b-only stay.
      applyTombstones({ appsDir: bApps, tombstonesDir: sharedTombstones });
      expect(existsSync(join(bApps, "obsolete"))).toBe(false);
      expect(existsSync(join(bApps, "alpha"))).toBe(true);
      expect(existsSync(join(bApps, "machine-b-only"))).toBe(true);
    } finally {
      rmSync(aRoot, { recursive: true, force: true });
      rmSync(bRoot, { recursive: true, force: true });
      rmSync(sharedSync, { recursive: true, force: true });
    }
  });
});

describe("tombstone push — resurrection", () => {
  // Without resurrection-clearing, a deleted-then-recreated app keeps getting
  // wiped on every pull anywhere in the fleet because the old tombstone
  // lingers in sync-repo.

  it("clears a stale tombstone when the app exists locally again", () => {
    makeApp("alpha"); makeApp("beta");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    removeApp("beta");
    const r1 = writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    expect(r1.newTombstones).toEqual(["beta"]);
    expect(existsSync(join(tombstonesDir, "beta.json"))).toBe(true);

    // beta resurrected with same name
    makeApp("beta");
    const r2 = writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    expect(r2.clearedTombstones).toEqual(["beta"]);
    expect(r2.newTombstones).toHaveLength(0);
    expect(existsSync(join(tombstonesDir, "beta.json"))).toBe(false);
  });

  it("only clears tombstones for resurrected apps, not for apps still gone", () => {
    makeApp("alpha"); makeApp("beta"); makeApp("gamma");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    removeApp("beta"); removeApp("gamma");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    expect(existsSync(join(tombstonesDir, "beta.json"))).toBe(true);
    expect(existsSync(join(tombstonesDir, "gamma.json"))).toBe(true);

    // Only beta resurrected; gamma stays gone
    makeApp("beta");
    const r = writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    expect(r.clearedTombstones).toEqual(["beta"]);
    expect(existsSync(join(tombstonesDir, "beta.json"))).toBe(false);
    expect(existsSync(join(tombstonesDir, "gamma.json"))).toBe(true);
  });

  it("noop when no tombstones exist (clearedTombstones stays empty)", () => {
    makeApp("alpha");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    makeApp("beta");
    const r = writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir });
    expect(r.clearedTombstones).toHaveLength(0);
    expect(r.newTombstones).toHaveLength(0);
  });
});

describe("tombstone push — sync-repo cleanup", () => {
  // additiveOnly mirroring leaves dead app trees in sync-repo. When we
  // tombstone an app, prune its sync-repo dir in the same step so storage
  // doesn't grow monotonically.

  it("prunes sync-repo's app tree when a tombstone is written", () => {
    const syncRepoAppsDir = join(tmpRoot, "sync-repo", "workspace", "apps");
    mkdirSync(join(syncRepoAppsDir, "alpha"), { recursive: true });
    writeFileSync(join(syncRepoAppsDir, "alpha", "index.html"), "<!-- alpha -->");
    mkdirSync(join(syncRepoAppsDir, "beta"), { recursive: true });
    writeFileSync(join(syncRepoAppsDir, "beta", "index.html"), "<!-- beta -->");

    makeApp("alpha"); makeApp("beta");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir, syncRepoAppsDir });

    removeApp("beta");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir, syncRepoAppsDir });

    expect(existsSync(join(syncRepoAppsDir, "beta"))).toBe(false);
    expect(existsSync(join(syncRepoAppsDir, "alpha"))).toBe(true);
  });

  it("safe when sync-repo doesn't have the app dir (already pruned, never pushed)", () => {
    const syncRepoAppsDir = join(tmpRoot, "sync-repo", "workspace", "apps");
    mkdirSync(syncRepoAppsDir, { recursive: true });

    makeApp("ghost");
    writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir, syncRepoAppsDir });
    removeApp("ghost");
    expect(() => writeTombstonesForDeletedApps({ appsDir, snapshotFile, tombstonesDir, syncRepoAppsDir })).not.toThrow();
    expect(existsSync(join(tombstonesDir, "ghost.json"))).toBe(true);
  });
});

describe("tombstone two-machine simulation — resurrection propagates correctly", () => {
  // The full lifecycle: A creates alpha, A deletes alpha (B's alpha removed
  // via tombstone), A recreates alpha, A pushes again. The tombstone must
  // be cleared so B's next pull doesn't re-delete alpha.

  it("recreated app on A clears tombstone so B can pick it back up", () => {
    const aRoot = mkdtempSync(join(tmpdir(), "tomb-A3-"));
    const aApps = join(aRoot, "workspace", "apps");
    const aSnap = join(aRoot, "sync-state", "last-pushed-apps.json");
    mkdirSync(join(aApps, "alpha"), { recursive: true });

    const bRoot = mkdtempSync(join(tmpdir(), "tomb-B3-"));
    const bApps = join(bRoot, "workspace", "apps");
    mkdirSync(join(bApps, "alpha"), { recursive: true });

    const sharedSync = mkdtempSync(join(tmpdir(), "tomb-sync3-"));
    const sharedTombstones = join(sharedSync, ".tombstones");

    try {
      // A baseline
      writeTombstonesForDeletedApps({ appsDir: aApps, snapshotFile: aSnap, tombstonesDir: sharedTombstones });

      // A deletes alpha → tombstone written
      rmSync(join(aApps, "alpha"), { recursive: true });
      const r1 = writeTombstonesForDeletedApps({ appsDir: aApps, snapshotFile: aSnap, tombstonesDir: sharedTombstones });
      expect(r1.newTombstones).toEqual(["alpha"]);

      // B pulls → alpha removed via tombstone
      applyTombstones({ appsDir: bApps, tombstonesDir: sharedTombstones });
      expect(existsSync(join(bApps, "alpha"))).toBe(false);

      // A recreates alpha → tombstone cleared
      mkdirSync(join(aApps, "alpha"), { recursive: true });
      const r2 = writeTombstonesForDeletedApps({ appsDir: aApps, snapshotFile: aSnap, tombstonesDir: sharedTombstones });
      expect(r2.clearedTombstones).toEqual(["alpha"]);
      expect(existsSync(join(sharedTombstones, "alpha.json"))).toBe(false);

      // B's next pull: no tombstone for alpha. (A real pullDir would copy
      // A's new alpha into bApps; we don't simulate pullDir, but the
      // load-bearing fact is that applyTombstones does nothing.)
      const removed = applyTombstones({ appsDir: bApps, tombstonesDir: sharedTombstones });
      expect(removed).toHaveLength(0);
    } finally {
      rmSync(aRoot, { recursive: true, force: true });
      rmSync(bRoot, { recursive: true, force: true });
      rmSync(sharedSync, { recursive: true, force: true });
    }
  });
});
