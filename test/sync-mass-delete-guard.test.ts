import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ABORT_THRESHOLD, findUnauthorizedAppDeletions } from "../src/sync/mass-delete-guard.js";

// The mass-deletion circuit breaker in src/sync/mass-delete-guard.ts refuses to push when
// workspace apps are being deleted without matching tombstones. Its
// authorization rule is the whole point of these tests: a tombstone AUTHORIZES
// a deletion by EXISTING, not by being newly staged.
//
// The regression this locks (2026-07-28 live failure): the guard used to read
// authorization out of `git status --porcelain`, accepting only tombstones
// staged A (added) or ? (untracked). But the normal UI-delete path pairs a
// deletion with an already-tracked tombstone:
//
//   cycle 1 — user deletes app  → tombstoneAppEagerly writes the tombstone
//                               → committed, so it is now TRACKED
//   cycle 2 — writeTombstonesForDeletedApps re-stamps deletedAt (staged M)
//                               → and only NOW prunes workspace/apps/<name> (staged D)
//
// D paired with M, never A. Three such apps and every later sync aborts
// forever with "push would mass-delete N workspace apps with no matching
// tombstones" — which is exactly what happened to four apps the user had
// legitimately deleted.

// Deletions come from porcelain (git is the only thing that knows a tree was
// pruned); authorization comes from the tombstones directory on disk, which
// after copyToSync holds the intended state.
function unauthorizedDeletes(porcelain: string, dir: string): string[] {
  return findUnauthorizedAppDeletions(porcelain, dir);
}

function aborts(porcelain: string, dir: string): boolean {
  return unauthorizedDeletes(porcelain, dir).length >= ABORT_THRESHOLD;
}

let syncDir: string;
let tombstonesDir: string;

beforeEach(() => {
  syncDir = mkdtempSync(join(tmpdir(), "sync-guard-test-"));
  tombstonesDir = join(syncDir, ".tombstones");
});

afterEach(() => {
  try { rmSync(syncDir, { recursive: true, force: true }); } catch {}
});

function tombstone(name: string): void {
  mkdirSync(tombstonesDir, { recursive: true });
  writeFileSync(join(tombstonesDir, `${name}.json`), JSON.stringify({
    name, deletedAt: new Date().toISOString(), deletedBy: "PMAJLABS",
  }));
}

/** One porcelain line per deleted file inside an app tree. */
function deletedApp(name: string): string {
  return `D  workspace/apps/${name}/index.html\nD  workspace/apps/${name}/app.js`;
}

describe("mass-delete guard — tombstone authorization is existence, not staging", () => {
  it("REGRESSION: an already-tracked tombstone (staged M) still authorizes its deletion", () => {
    // The exact live failure. Four apps deleted through the UI, each with a
    // tombstone committed by an earlier cycle and re-stamped by this one.
    const apps = ["dolphin-calculator", "eagle-todo", "expense-tracker", "funding-scanner"];
    const porcelain = [
      ...apps.map(deletedApp),
      ...apps.map(a => `M  .tombstones/${a}.json`),
    ].join("\n");
    apps.forEach(tombstone);

    expect(unauthorizedDeletes(porcelain, syncDir)).toEqual([]);
    expect(aborts(porcelain, syncDir)).toBe(false);
  });

  it("a tombstone absent from porcelain entirely (tracked, unchanged) still authorizes", () => {
    // Deletion staged this cycle, tombstone committed long ago and untouched —
    // so it never appears in `git status` at all.
    const apps = ["alpha", "beta", "gamma"];
    const porcelain = apps.map(deletedApp).join("\n");
    apps.forEach(tombstone);

    expect(aborts(porcelain, syncDir)).toBe(false);
  });

  it("a freshly-added tombstone still authorizes (the original path keeps working)", () => {
    const apps = ["weather-app", "wod-test", "dice-roller"];
    const porcelain = [
      ...apps.map(deletedApp),
      ...apps.map(a => `A  .tombstones/${a}.json`),
    ].join("\n");
    apps.forEach(tombstone);

    expect(aborts(porcelain, syncDir)).toBe(false);
  });

  it("mixed M and A tombstones in one push all authorize", () => {
    // The user's real push: 8 apps with new tombstones + 4 with re-stamped ones.
    const fresh = ["weather-app", "wod-test", "dino-todo", "goon-schedule"];
    const restamped = ["dolphin-calculator", "eagle-todo", "expense-tracker", "funding-scanner"];
    const porcelain = [
      ...[...fresh, ...restamped].map(deletedApp),
      ...fresh.map(a => `A  .tombstones/${a}.json`),
      ...restamped.map(a => `M  .tombstones/${a}.json`),
    ].join("\n");
    [...fresh, ...restamped].forEach(tombstone);

    expect(aborts(porcelain, syncDir)).toBe(false);
  });
});

describe("mass-delete guard — still catches genuinely unauthorized deletions", () => {
  it("aborts when apps are deleted with no tombstone on disk", () => {
    // The 2026-05-05 failure this guard exists for: a stale clone pruning
    // apps that belong to other machines, nothing authorizing it.
    const apps = ["alpha", "beta", "gamma", "delta"];
    const porcelain = apps.map(deletedApp).join("\n");

    expect(unauthorizedDeletes(porcelain, syncDir).sort()).toEqual([...apps].sort());
    expect(aborts(porcelain, syncDir)).toBe(true);
  });

  it("a tombstone staged for DELETION grants nothing — it is gone from disk", () => {
    // Resurrection clears tombstones. If a clone were both clearing tombstones
    // and pruning the app trees, that must still abort.
    const apps = ["alpha", "beta", "gamma"];
    const porcelain = [
      ...apps.map(deletedApp),
      ...apps.map(a => `D  .tombstones/${a}.json`),
    ].join("\n");
    // Deliberately do NOT create the files — staged D means absent on disk.

    expect(aborts(porcelain, syncDir)).toBe(true);
  });

  it("tombstones for OTHER apps do not authorize an untombstoned deletion", () => {
    const porcelain = ["alpha", "beta", "gamma"].map(deletedApp).join("\n");
    ["unrelated-one", "unrelated-two", "unrelated-three"].forEach(tombstone);

    expect(unauthorizedDeletes(porcelain, syncDir).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(aborts(porcelain, syncDir)).toBe(true);
  });

  it("stays under threshold for one or two untombstoned deletions", () => {
    const porcelain = [deletedApp("alpha"), deletedApp("beta")].join("\n");
    expect(unauthorizedDeletes(porcelain, syncDir)).toHaveLength(2);
    expect(aborts(porcelain, syncDir)).toBe(false);
  });

  it("counts apps, not files — one app losing 50 files is a single deletion", () => {
    const porcelain = Array.from({ length: 50 }, (_, i) =>
      `D  workspace/apps/wod-test/assets/file-${i}.svg`).join("\n");
    expect(unauthorizedDeletes(porcelain, syncDir)).toEqual(["wod-test"]);
    expect(aborts(porcelain, syncDir)).toBe(false);
  });
});

describe("mass-delete guard — edge cases", () => {
  it("missing tombstones dir behaves as zero authorization, not a throw", () => {
    const porcelain = ["alpha", "beta", "gamma"].map(deletedApp).join("\n");
    expect(existsSync(tombstonesDir)).toBe(false);
    expect(() => unauthorizedDeletes(porcelain, syncDir)).not.toThrow();
    expect(aborts(porcelain, syncDir)).toBe(true);
  });

  it("ignores non-.json entries in the tombstones dir", () => {
    mkdirSync(tombstonesDir, { recursive: true });
    writeFileSync(join(tombstonesDir, "alpha"), "not a tombstone");
    writeFileSync(join(tombstonesDir, "beta.txt"), "wrong extension");
    tombstone("gamma");
    const porcelain = ["alpha", "beta", "gamma"].map(deletedApp).join("\n");
    expect(unauthorizedDeletes(porcelain, syncDir).sort()).toEqual(["alpha", "beta"]);
  });

  it("modifications and additions under workspace/apps are not deletions", () => {
    const porcelain = [
      "M  workspace/apps/merchhelm/index.html",
      "A  workspace/apps/truckfinder/app.js",
      "?? workspace/apps/newthing/index.html",
    ].join("\n");
    expect(unauthorizedDeletes(porcelain, syncDir)).toEqual([]);
  });

  it("a deleted file directly under workspace/apps (not in an app dir) is ignored", () => {
    // Only top-level app DIRECTORIES are tombstonable units.
    const porcelain = "D  workspace/apps/README.md";
    expect(unauthorizedDeletes(porcelain, syncDir)).toEqual([]);
  });

  it("empty porcelain yields no deletions", () => {
    expect(unauthorizedDeletes("", syncDir)).toEqual([]);
  });
});
