import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
    const cfgPath = join(homedir(), ".lax", "config.json");
    if (!existsSync(cfgPath)) return;
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      let changed = false;
      const defaults: Record<string, unknown> = {
        maxIterations: 40, temperature: 0.7, profile: "home",
        toolApproval: "confirm-risky", retentionDays: 90,
        logLevel: "basic", browserCdpPort: 9800,
        browserIdleTimeoutMs: 600000, agentTimeoutMs: 300000,
      };
      for (const [key, value] of Object.entries(defaults)) {
        if (cfg[key] === undefined) { cfg[key] = value; changed = true; }
      }
      if (changed) writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
    } catch {}
  },
});

// v2: Add projectRoot for desktop app (loads latest code from repo)
registerBuiltinMigration({
  version: 2,
  name: "add-project-root",
  up: () => {
    const cfgPath = join(homedir(), ".lax", "config.json");
    if (!existsSync(cfgPath)) return;
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (!cfg.projectRoot) {
        cfg.projectRoot = process.cwd();
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
      }
    } catch {}
  },
});

function registerBuiltinMigration(m: Migration): void {
  const existing = registeredMigrations.find(x => x.version === m.version);
  if (!existing) { registeredMigrations.push(m); registeredMigrations.sort((a, b) => a.version - b.version); }
}

function versionFilePath(): string {
  return join(homedir(), ".lax", "migration-version.json");
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
  const dir = join(homedir(), ".lax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(versionFilePath(), JSON.stringify(version, null, 2), { encoding: "utf-8", mode: 0o600 });
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
