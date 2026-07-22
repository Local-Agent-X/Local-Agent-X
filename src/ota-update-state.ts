import { closeSync, fsyncSync, openSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface UpdateHistoryEntry {
  version: string;
  appliedAt: string;
  status: "applied" | "rolled-back";
  previousVersion: string;
  targetVersion?: string;
  transactionId?: string;
}

async function durableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  const file = openSync(temporary, "r+");
  try { fsyncSync(file); } finally { closeSync(file); }
  await rename(temporary, path);
  try {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { /* Windows cannot fsync directories; the atomic rename still holds. */ }
}

export async function readInstalledCommit(path: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf-8")) as { commit?: unknown };
    if (typeof value.commit !== "string" || !value.commit) throw new Error("Installed source record is invalid.");
    return value.commit;
  } catch {
    return null;
  }
}

export async function writeInstalledCommit(path: string, commit: string): Promise<void> {
  await durableJson(path, { commit, updatedAt: new Date().toISOString() });
}

export async function readUpdateHistory(path: string): Promise<UpdateHistoryEntry[]> {
  try {
    const value = JSON.parse(await readFile(path, "utf-8")) as unknown;
    if (!Array.isArray(value)) throw new Error("Update history is invalid.");
    return value as UpdateHistoryEntry[];
  } catch {
    return [];
  }
}

export async function writeUpdateHistory(path: string, entries: UpdateHistoryEntry[]): Promise<void> {
  await durableJson(path, entries);
}

export async function upsertAppliedHistory(path: string, entry: UpdateHistoryEntry): Promise<void> {
  const history = await readUpdateHistory(path);
  const existing = entry.transactionId
    ? history.find((candidate) => candidate.transactionId === entry.transactionId)
    : undefined;
  if (existing) Object.assign(existing, entry);
  else history.push(entry);
  await writeUpdateHistory(path, history);
}

export async function markHistoryRolledBack(
  path: string, transactionId: string, previousVersion: string, targetVersion: string,
): Promise<void> {
  const history = await readUpdateHistory(path);
  const existing = [...history].reverse().find((entry) => entry.transactionId === transactionId)
    ?? [...history].reverse().find((entry) => entry.status === "applied" && entry.previousVersion === previousVersion
      && (!entry.targetVersion || entry.targetVersion === targetVersion));
  if (!existing || existing.status === "rolled-back") return;
  existing.status = "rolled-back";
  existing.transactionId ??= transactionId;
  await writeUpdateHistory(path, history);
}
