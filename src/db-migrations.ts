import { existsSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { atomicWriteFileSync } from "./server-utils.js";
import { recordUserNotice, SPEND_BUDGET_NOTICE_ID, SPEND_BUDGET_NOTICE_TEXT } from "./user-notice.js";

export interface Migration {
  version: number;
  name: string;
  up: (dataDir: string) => Promise<void> | void;
}

interface MigrationVersion {
  currentVersion: number;
  appliedMigrations: Array<{
    version: number;
    name: string;
    appliedAt: number;
  }>;
}

const registeredMigrations: Migration[] = [];

// ── Built-in Migrations ──

// v1: Ensure config has all required fields with defaults
registerBuiltinMigration({
  version: 1,
  name: "config-defaults",
  up: (dataDir: string) => {
    const cfgPath = join(getLaxDir(), "config.json");
    if (!existsSync(cfgPath)) return;
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      let changed = false;
      const defaults: Record<string, unknown> = {
        maxIterations: 160, temperature: 0.7, profile: "home",
        toolApproval: "confirm-risky", retentionDays: 90,
        logLevel: "basic", browserCdpPort: 9800,
        browserMode: "in-app",
        browserIdleTimeoutMs: 600000, agentTimeoutMs: 300000,
      };
      for (const [key, value] of Object.entries(defaults)) {
        if (cfg[key] === undefined) { cfg[key] = value; changed = true; }
      }
      if (changed) atomicWriteFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    } catch {}
  },
});

// v2: Add projectRoot for desktop app (loads latest code from repo)
registerBuiltinMigration({
  version: 2,
  name: "add-project-root",
  up: () => {
    const cfgPath = join(getLaxDir(), "config.json");
    if (!existsSync(cfgPath)) return;
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (!cfg.projectRoot) {
        cfg.projectRoot = process.cwd();
        atomicWriteFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      }
    } catch {}
  },
});

// v3: Remove the dead tiered-memory store. addMemory/searchTiered/deepRecall
// had zero callers, so ~/.lax/memory-tiers.json was a permanently-empty file
// that reclassifyAll rewrote daily and that rode the sync manifest. The code is
// gone; unlink the stale file left behind on OTA-updated installs.
registerBuiltinMigration({
  version: 3,
  name: "remove-dead-memory-tiers-store",
  up: () => {
    const stalePath = join(getLaxDir(), "memory-tiers.json");
    if (!existsSync(stalePath)) return;
    unlinkSync(stalePath);
  },
});

// v4: Spend ceilings became ON by default ($75/day, $15/session) in
// config-schema, but a schema default only applies to a key that is ABSENT.
// saveConfig writes the whole parsed config back, so every install that ever
// opened Settings has `dailyBudgetUsd: 0, sessionBudgetUsd: 0` stored
// explicitly — and both enforcement points (the spend-cap rule pack and the
// checkpoint-stop predicate) short-circuit on 0. Those installs would silently
// keep no spend ceiling at all. Flip a stored 0 to the new default ONCE. The
// migration-version marker guarantees it never re-applies: a user who sets 0
// after this has run keeps 0 forever.
registerBuiltinMigration({
  version: 4,
  name: "spend-budget-defaults",
  up: () => {
    const cfgPath = join(getLaxDir(), "config.json");
    if (!existsSync(cfgPath)) return;
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    } catch {
      return;
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return;
    let changed = false;
    for (const [key, value] of [["dailyBudgetUsd", 75], ["sessionBudgetUsd", 15]] as const) {
      if (cfg[key] === 0) { cfg[key] = value; changed = true; }
    }
    if (!changed) return;
    atomicWriteFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    // Tell the user ONCE that we changed their caps. We can't emit here —
    // migrations are awaited before the socket binds — so record a pending
    // notice; server/index.ts drains it post-bind. Only on `changed`, so an
    // install that never stored 0s is never told about a migration that did
    // nothing to it.
    recordUserNotice(SPEND_BUDGET_NOTICE_ID, SPEND_BUDGET_NOTICE_TEXT);
  },
});

function registerBuiltinMigration(m: Migration): void {
  const existing = registeredMigrations.find(x => x.version === m.version);
  if (!existing) { registeredMigrations.push(m); registeredMigrations.sort((a, b) => a.version - b.version); }
}

function versionFilePath(): string {
  return join(getLaxDir(), "migration-version.json");
}

function loadVersion(): MigrationVersion {
  const p = versionFilePath();
  if (!existsSync(p)) {
    return { currentVersion: 0, appliedMigrations: [] };
  }
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { currentVersion: 0, appliedMigrations: [] };
  }
}

function saveVersion(version: MigrationVersion): void {
  const dir = getLaxDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(versionFilePath(), JSON.stringify(version, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function registerMigration(migration: Migration): void {
  const existing = registeredMigrations.find((m) => m.version === migration.version);
  if (existing) {
    throw new Error(`Migration version ${migration.version} already registered: "${existing.name}"`);
  }
  registeredMigrations.push(migration);
  registeredMigrations.sort((a, b) => a.version - b.version);
}

export function getMigrationStatus(): {
  currentVersion: number;
  pendingCount: number;
  pendingVersions: number[];
  appliedMigrations: MigrationVersion["appliedMigrations"];
} {
  const versionData = loadVersion();
  const pending = registeredMigrations.filter(
    (m) => m.version > versionData.currentVersion,
  );

  return {
    currentVersion: versionData.currentVersion,
    pendingCount: pending.length,
    pendingVersions: pending.map((m) => m.version),
    appliedMigrations: versionData.appliedMigrations,
  };
}

export async function runMigrations(
  dataDir: string,
): Promise<{
  applied: Array<{ version: number; name: string }>;
  skipped: number;
  error?: string;
}> {
  const versionData = loadVersion();
  const pending = registeredMigrations.filter(
    (m) => m.version > versionData.currentVersion,
  );

  if (pending.length === 0) {
    return { applied: [], skipped: 0 };
  }

  const applied: Array<{ version: number; name: string }> = [];

  for (const migration of pending) {
    try {
      await migration.up(dataDir);

      versionData.currentVersion = migration.version;
      versionData.appliedMigrations.push({
        version: migration.version,
        name: migration.name,
        appliedAt: Date.now(),
      });
      saveVersion(versionData);
      applied.push({ version: migration.version, name: migration.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        applied,
        skipped: pending.length - applied.length,
        error: `Migration ${migration.version} ("${migration.name}") failed: ${message}`,
      };
    }
  }

  return { applied, skipped: 0 };
}
