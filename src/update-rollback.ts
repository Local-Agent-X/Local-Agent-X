import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const VERSION = 1;

export interface UpdateRollbackEntry { path: string; existed: boolean; sha256: string | null }
export interface UpdateRollbackJournal {
  version: 1;
  id: string;
  status: "backing-up" | "active" | "applied" | "verified" | "restored";
  installRoot: string;
  previousVersion: string;
  targetVersion: string;
  entries: UpdateRollbackEntry[];
  startedAt: string;
  restoredAt?: string;
  reason?: string;
}

function durableJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  const file = openSync(temporary, "r+");
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, path);
  try {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { /* Windows cannot fsync directories; the atomic rename still holds. */ }
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function safeRelative(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

export class UpdateRollbackTransaction {
  readonly directory: string;
  readonly journalPath: string;
  readonly backupRoot: string;

  constructor(private readonly stateRoot: string, private readonly fault: (point: string) => void = () => {}) {
    this.directory = join(stateRoot, "update-rollback");
    this.journalPath = join(this.directory, "transaction.json");
    this.backupRoot = join(this.directory, "artifacts");
  }

  async read(): Promise<UpdateRollbackJournal | null> {
    try {
      const value = JSON.parse(await readFile(this.journalPath, "utf-8")) as UpdateRollbackJournal;
      if (value.version !== VERSION || !["backing-up", "active", "applied", "verified", "restored"].includes(value.status)) throw new Error();
      if (!value.installRoot || !value.previousVersion || !value.targetVersion || !Array.isArray(value.entries)) throw new Error();
      if (!value.entries.every((entry) => safeRelative(entry.path) && typeof entry.existed === "boolean"
        && (entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256)))) throw new Error();
      return value;
    } catch (error) {
      try { await stat(this.journalPath); } catch { return null; }
      throw new Error("Update rollback journal has ambiguous provenance; refusing to mutate the installation.", { cause: error });
    }
  }

  async begin(installRoot: string, previousVersion: string, targetVersion: string, paths: string[]): Promise<void> {
    if (await this.read()) throw new Error("An update rollback transaction is already pending.");
    const root = resolve(installRoot);
    const entries: UpdateRollbackEntry[] = [];
    await mkdir(this.backupRoot, { recursive: true });
    for (const path of [...new Set(paths)].sort()) {
      if (!safeRelative(path)) throw new Error(`Unsafe update path '${path}'.`);
      const source = resolve(root, path);
      if (!source.startsWith(`${root}\\`) && !source.startsWith(`${root}/`)) throw new Error(`Update path escapes install root: ${path}`);
      try {
        if (!(await stat(source)).isFile()) throw new Error(`Update target is not a regular file: ${path}`);
        const sha256 = await digest(source);
        entries.push({ path, existed: true, sha256 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") entries.push({ path, existed: false, sha256: null });
        else throw error;
      }
    }
    const journal: UpdateRollbackJournal = {
      version: VERSION, id: randomUUID(), status: "backing-up", installRoot: root,
      previousVersion, targetVersion, entries, startedAt: new Date().toISOString(),
    };
    durableJson(this.journalPath, journal);
    this.fault("after-backup-journal");
    for (const entry of entries) {
      if (!entry.existed) continue;
      const backup = join(this.backupRoot, entry.path);
      await mkdir(dirname(backup), { recursive: true });
      await copyFile(join(root, entry.path), backup);
      this.fault(`after-backup-entry:${entry.path}`);
    }
    journal.status = "active";
    durableJson(this.journalPath, journal);
    this.fault("after-backup");
  }

  async markApplied(targetVersion: string): Promise<void> {
    const journal = await this.require(targetVersion);
    journal.status = "applied";
    durableJson(this.journalPath, journal);
    this.fault("after-applied");
  }

  async markVerified(targetVersion: string): Promise<void> {
    const journal = await this.require(targetVersion);
    journal.status = "verified";
    durableJson(this.journalPath, journal);
    this.fault("after-verified");
  }

  async restore(installRoot: string, targetVersion: string, reason: string): Promise<UpdateRollbackJournal> {
    const journal = await this.require(targetVersion);
    if (resolve(installRoot) !== resolve(journal.installRoot)) throw new Error("Rollback install identity does not match this installation.");
    if (journal.status === "restored") return journal;
    if (journal.status === "backing-up") {
      for (const entry of journal.entries) {
        const target = join(journal.installRoot, entry.path);
        if (entry.existed) {
          try {
            if (await digest(target) !== entry.sha256) throw new Error();
          } catch { throw new Error(`Interrupted backup left ambiguous source state: ${entry.path}`); }
        } else {
          try { await stat(target); throw new Error(`Interrupted backup created unexpected artifact: ${entry.path}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
      journal.status = "restored";
      journal.restoredAt = new Date().toISOString();
      journal.reason = reason;
      durableJson(this.journalPath, journal);
      durableJson(join(this.stateRoot, "update-rollback-report.json"), journal);
      return journal;
    }
    this.fault("before-restore");
    for (const entry of [...journal.entries].reverse()) {
      const target = join(journal.installRoot, entry.path);
      if (entry.existed) {
        const backup = join(this.backupRoot, entry.path);
        if (await digest(backup) !== entry.sha256) throw new Error(`Rollback backup failed integrity verification: ${entry.path}`);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(backup, target);
        if (await digest(target) !== entry.sha256) throw new Error(`Rollback restore failed verification: ${entry.path}`);
      } else await rm(target, { force: true });
    }
    journal.status = "restored";
    journal.restoredAt = new Date().toISOString();
    journal.reason = reason;
    durableJson(this.journalPath, journal);
    durableJson(join(this.stateRoot, "update-rollback-report.json"), journal);
    this.fault("after-restore");
    return journal;
  }

  async clearRestored(): Promise<void> {
    const journal = await this.read();
    if (journal?.status === "restored") await rm(this.directory, { recursive: true, force: true });
  }

  async clearVerified(): Promise<void> {
    const journal = await this.read();
    if (journal?.status === "verified") await rm(this.directory, { recursive: true, force: true });
  }

  private async require(targetVersion: string): Promise<UpdateRollbackJournal> {
    const journal = await this.read();
    if (!journal) throw new Error("Update rollback transaction is missing.");
    if (journal.targetVersion !== targetVersion) throw new Error("Rollback target identity does not match the selected update.");
    return journal;
  }
}
