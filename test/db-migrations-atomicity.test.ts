/**
 * Regression suite for runMigrations (src/db-migrations.ts).
 *
 * Contract under test — migration atomicity:
 *   - A migration whose up() throws must NOT advance the saved version, and
 *     must re-run (still be pending) on the next call.
 *   - A migration that succeeds advances the version exactly once, is recorded
 *     in appliedMigrations, and is NOT re-run on a subsequent call.
 *
 * Seam: db-migrations has no migration-list injection API; it keeps a single
 * module-level `registeredMigrations` array (mutated via the public
 * `registerMigration`) plus a couple of built-in migrations (v1, v2). There is
 * also no way to unregister a migration, and registerMigration throws on
 * duplicate versions — so registered migrations would otherwise leak across
 * tests, and an earlier test's throwing migration (lowest version runs first)
 * would block every later test. We therefore give each test a fresh copy of the
 * module via vi.resetModules() + dynamic import, so module-level state
 * (registeredMigrations) starts clean every time.
 *
 * The version file path is resolved through getLaxDir() *at call time*, which
 * honors LAX_DATA_DIR. We point LAX_DATA_DIR at a fresh temp dir per test, so
 * each test starts from currentVersion: 0 on disk.
 *
 * The two built-ins (config-defaults, add-project-root) are no-ops when no
 * config.json exists in the data dir — which is the case for our temp dirs — so
 * they apply cleanly and don't interfere with the probes.
 *
 * Date.now() is frozen with fake timers so appliedAt is deterministic.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DbMigrations = typeof import("../src/db-migrations.js");

const FROZEN_NOW = new Date("2026-06-02T12:00:00.000Z");

const tmpDirs: string[] = [];
let dataDir: string;
let mod: DbMigrations;
let registerMigration: DbMigrations["registerMigration"];
let runMigrations: DbMigrations["runMigrations"];
let getMigrationStatus: DbMigrations["getMigrationStatus"];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "db-migrations-atomicity-"));
  tmpDirs.push(dataDir);
  process.env.LAX_DATA_DIR = dataDir;
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
  // Fresh module state (registeredMigrations) per test.
  vi.resetModules();
  mod = await import("../src/db-migrations.js");
  ({ registerMigration, runMigrations, getMigrationStatus } = mod);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.LAX_DATA_DIR;
});

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function readVersionFile(): {
  currentVersion: number;
  appliedMigrations: Array<{ version: number; name: string; appliedAt: number }>;
} {
  const p = join(dataDir, "migration-version.json");
  expect(existsSync(p)).toBe(true);
  return JSON.parse(readFileSync(p, "utf-8"));
}

describe("runMigrations — atomicity on failure", () => {
  it("a failing up() does NOT advance the saved version and re-runs next call", async () => {
    let attempts = 0;
    // Unique high version range for this test.
    registerMigration({
      version: 1001,
      name: "always-throws",
      up: () => {
        attempts++;
        throw new Error("boom");
      },
    });

    // First run: the throwing migration fails.
    const first = await runMigrations(dataDir);
    expect(attempts).toBe(1);
    expect(first.error).toContain('Migration 1001 ("always-throws") failed: boom');
    // The failing migration must NOT appear as applied.
    expect(first.applied.map((m) => m.version)).not.toContain(1001);

    // Saved version must not have advanced to 1001 (it must remain < 1001).
    const afterFail = getMigrationStatus();
    expect(afterFail.currentVersion).toBeLessThan(1001);
    expect(afterFail.pendingVersions).toContain(1001);
    expect(afterFail.appliedMigrations.map((m) => m.version)).not.toContain(1001);

    // Second run: the migration must re-run because it was never recorded.
    const second = await runMigrations(dataDir);
    expect(attempts).toBe(2);
    expect(second.error).toContain('Migration 1001 ("always-throws") failed');

    // Still pending after the second failure, version still parked below 1001.
    expect(getMigrationStatus().pendingVersions).toContain(1001);
    expect(getMigrationStatus().currentVersion).toBeLessThan(1001);
  });

  it("migrations before a failing one stay applied; the failing + later ones stay pending", async () => {
    const order: number[] = [];
    registerMigration({
      version: 2001,
      name: "ok-before",
      up: () => {
        order.push(2001);
      },
    });
    registerMigration({
      version: 2002,
      name: "throws-mid",
      up: () => {
        order.push(2002);
        throw new Error("mid-failure");
      },
    });
    registerMigration({
      version: 2003,
      name: "never-reached",
      up: () => {
        order.push(2003);
      },
    });

    const result = await runMigrations(dataDir);

    // The pre-failure migration ran and is recorded.
    expect(result.applied.map((m) => m.version)).toContain(2001);
    // The failing one is reported as the error and NOT applied.
    expect(result.error).toContain('Migration 2002 ("throws-mid") failed: mid-failure');
    expect(result.applied.map((m) => m.version)).not.toContain(2002);
    // The later migration never executed.
    expect(order).not.toContain(2003);
    expect(result.applied.map((m) => m.version)).not.toContain(2003);

    // Saved version stopped at the last successful migration (2001), not 2002/2003.
    const status = getMigrationStatus();
    expect(status.currentVersion).toBe(2001);
    expect(status.pendingVersions).toEqual(expect.arrayContaining([2002, 2003]));
    expect(status.appliedMigrations.map((m) => m.version)).toContain(2001);
    expect(status.appliedMigrations.map((m) => m.version)).not.toContain(2002);
  });
});

describe("runMigrations — successful migrations apply exactly once", () => {
  it("a succeeding migration advances version once, is recorded, and is not re-run", async () => {
    let runCount = 0;
    registerMigration({
      version: 3001,
      name: "succeeds-once",
      up: () => {
        runCount++;
      },
    });

    // First run applies it.
    const first = await runMigrations(dataDir);
    expect(runCount).toBe(1);
    expect(first.error).toBeUndefined();
    expect(first.applied.map((m) => m.version)).toContain(3001);

    // Version advanced and the migration is recorded with the frozen timestamp.
    const status = getMigrationStatus();
    expect(status.currentVersion).toBe(3001);
    expect(status.pendingVersions).not.toContain(3001);
    const recorded = status.appliedMigrations.find((m) => m.version === 3001);
    expect(recorded).toBeDefined();
    expect(recorded?.name).toBe("succeeds-once");
    expect(recorded?.appliedAt).toBe(FROZEN_NOW.getTime());

    // On-disk version file reflects it too.
    const persisted = readVersionFile();
    expect(persisted.currentVersion).toBe(3001);
    expect(persisted.appliedMigrations.filter((m) => m.version === 3001)).toHaveLength(1);

    // Second run must be a no-op for this migration — it is NOT re-run.
    const second = await runMigrations(dataDir);
    expect(runCount).toBe(1);
    expect(second.applied.map((m) => m.version)).not.toContain(3001);

    // And it appears exactly once in appliedMigrations (no duplicate record).
    const afterSecond = getMigrationStatus();
    expect(
      afterSecond.appliedMigrations.filter((m) => m.version === 3001),
    ).toHaveLength(1);
  });
});
