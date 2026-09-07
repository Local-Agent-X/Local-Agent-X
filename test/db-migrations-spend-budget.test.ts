/**
 * Regression suite for migration v4 ("spend-budget-defaults") in
 * src/db-migrations.ts.
 *
 * Contract under test:
 *   - config-schema now defaults dailyBudgetUsd: 75 / sessionBudgetUsd: 15, but
 *     a schema default only fills a key that is ABSENT. saveConfig writes the
 *     whole parsed config back, so any install that ever saved Settings has an
 *     explicit `0` stored — and both enforcement points short-circuit on 0.
 *   - The migration flips a stored 0 to the new default exactly ONCE per
 *     install. The migration-version marker (not a heuristic) is what makes it
 *     one-shot: a user who sets 0 AFTER the migration keeps 0 forever.
 *   - A user-chosen non-zero value is untouched.
 *   - An absent key is untouched (the schema default already covers it) and the
 *     marker is still recorded so the migration can never fire later.
 *   - Unrelated keys survive the read/rewrite round-trip byte-for-byte.
 *
 * Seam notes (mirrors test/db-migrations-atomicity.test.ts): db-migrations keeps
 * module-level state, so each test gets a fresh module via vi.resetModules() +
 * dynamic import. Paths resolve through getLaxDir() at call time, so LAX_DATA_DIR
 * points at a fresh temp dir per test — the user's real ~/.lax is never touched.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DbMigrations = typeof import("../src/db-migrations.js");

const tmpDirs: string[] = [];
let dataDir: string;
let runMigrations: DbMigrations["runMigrations"];
let getMigrationStatus: DbMigrations["getMigrationStatus"];

const SPEND_MIGRATION_VERSION = 4;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "db-migrations-spend-"));
  tmpDirs.push(dataDir);
  process.env.LAX_DATA_DIR = dataDir;
  vi.resetModules();
  const mod = await import("../src/db-migrations.js");
  ({ runMigrations, getMigrationStatus } = mod);
});

afterEach(() => {
  delete process.env.LAX_DATA_DIR;
});

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function cfgPath(): string {
  return join(dataDir, "config.json");
}

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), "utf-8");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(cfgPath(), "utf-8"));
}

function markerRecorded(): boolean {
  const status = getMigrationStatus();
  return (
    status.currentVersion >= SPEND_MIGRATION_VERSION &&
    status.appliedMigrations.some((m) => m.version === SPEND_MIGRATION_VERSION)
  );
}

describe("migration v4 — spend-budget-defaults", () => {
  it("flips explicit 0s to the new defaults and records the marker", async () => {
    writeConfig({ dailyBudgetUsd: 0, sessionBudgetUsd: 0, profile: "home" });

    const result = await runMigrations(dataDir);
    expect(result.error).toBeUndefined();
    expect(result.applied.map((m) => m.version)).toContain(SPEND_MIGRATION_VERSION);

    const cfg = readConfig();
    expect(cfg.dailyBudgetUsd).toBe(75);
    expect(cfg.sessionBudgetUsd).toBe(15);
    expect(markerRecorded()).toBe(true);
  });

  it("flips only the key that is 0 when the other is user-chosen", async () => {
    writeConfig({ dailyBudgetUsd: 40, sessionBudgetUsd: 0 });

    await runMigrations(dataDir);

    const cfg = readConfig();
    expect(cfg.dailyBudgetUsd).toBe(40);
    expect(cfg.sessionBudgetUsd).toBe(15);
  });

  it("leaves a user-chosen non-zero value untouched", async () => {
    writeConfig({ dailyBudgetUsd: 40, sessionBudgetUsd: 5 });

    await runMigrations(dataDir);

    const cfg = readConfig();
    expect(cfg.dailyBudgetUsd).toBe(40);
    expect(cfg.sessionBudgetUsd).toBe(5);
  });

  it("does NOT re-apply on the next boot: a 0 set AFTER the migration stays 0", async () => {
    writeConfig({ dailyBudgetUsd: 0, sessionBudgetUsd: 0 });
    await runMigrations(dataDir);
    expect(readConfig().dailyBudgetUsd).toBe(75);

    // The user deliberately opts out afterwards.
    writeConfig({ dailyBudgetUsd: 0, sessionBudgetUsd: 0 });

    // Fresh module (fresh process) — the marker on disk is the only guard.
    vi.resetModules();
    const mod = await import("../src/db-migrations.js");
    const second = await mod.runMigrations(dataDir);

    expect(second.applied.map((m) => m.version)).not.toContain(SPEND_MIGRATION_VERSION);
    const cfg = readConfig();
    expect(cfg.dailyBudgetUsd).toBe(0);
    expect(cfg.sessionBudgetUsd).toBe(0);
  });

  it("leaves ABSENT keys absent (schema defaults own that case) but still records the marker", async () => {
    writeConfig({ profile: "home", temperature: 0.7 });

    await runMigrations(dataDir);

    const cfg = readConfig();
    // v1 (config-defaults) backfills its own list; the budget keys are not on it.
    expect("dailyBudgetUsd" in cfg).toBe(false);
    expect("sessionBudgetUsd" in cfg).toBe(false);
    expect(markerRecorded()).toBe(true);
  });

  it("is idempotent and does not corrupt unrelated keys (diskExtras round-trip)", async () => {
    const extras = {
      dailyBudgetUsd: 0,
      sessionBudgetUsd: 0,
      someUnknownFutureKey: { nested: [1, 2, 3], flag: true },
      apiKeyAlias: "kept-verbatim",
      modelDailyBudgetsUsd: { "claude-opus-5": 12.5 },
    };
    writeConfig(extras);

    await runMigrations(dataDir);
    const afterFirst = readConfig();

    // Second full pass (fresh module) must change nothing further.
    vi.resetModules();
    const mod = await import("../src/db-migrations.js");
    await mod.runMigrations(dataDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.someUnknownFutureKey).toEqual(extras.someUnknownFutureKey);
    expect(afterSecond.apiKeyAlias).toBe("kept-verbatim");
    expect(afterSecond.modelDailyBudgetsUsd).toEqual({ "claude-opus-5": 12.5 });
    expect(afterSecond.dailyBudgetUsd).toBe(75);
    expect(afterSecond.sessionBudgetUsd).toBe(15);
  });

  it("is a no-op with no config.json, and still records the marker", async () => {
    expect(existsSync(cfgPath())).toBe(false);

    const result = await runMigrations(dataDir);

    expect(result.error).toBeUndefined();
    expect(existsSync(cfgPath())).toBe(false);
    expect(markerRecorded()).toBe(true);
  });
});
