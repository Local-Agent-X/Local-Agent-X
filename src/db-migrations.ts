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

function versionFilePath(): string {
  return join(homedir(), ".sax", "migration-version.json");
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
  const dir = join(homedir(), ".sax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(versionFilePath(), JSON.stringify(version, null, 2), "utf-8");
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
