/**
 * Active-orchestrator registry — tracks every project_dir that has an
 * in-flight build so the LAX boot scanner can find and auto-resume them.
 *
 * Lives at `~/.lax/active-orchestrators.json`. Format:
 *   { entries: [{ projectDir, opId, sessionId, registeredAt }, ...] }
 *
 * Distinct from each project's `.primal-orchestrator-state.json` — that
 * file is the canonical state (used to resume). The registry is just a
 * pointer list so the boot scanner doesn't have to scan the entire
 * filesystem looking for state files.
 *
 * Best-effort: file IO failures don't halt the build. Worst case, a
 * server restart loses the auto-resume hint and the user has to call
 * primal_build_resume manually.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RegistryEntry {
  projectDir: string;
  opId: string;
  sessionId: string;
  registeredAt: string;
}

interface RegistryFile {
  entries: RegistryEntry[];
}

function registryPath(): string {
  return join(homedir(), ".lax", "active-orchestrators.json");
}

function read(): RegistryFile {
  const p = registryPath();
  if (!existsSync(p)) return { entries: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<RegistryFile>;
    return { entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function write(file: RegistryFile): void {
  const p = registryPath();
  const tmp = p + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2));
    renameSync(tmp, p);
  } catch {
    /* best-effort */
  }
}

export function register(entry: RegistryEntry): void {
  const f = read();
  // Replace any existing entry for the same projectDir (one build per dir at a time).
  const filtered = f.entries.filter(e => e.projectDir !== entry.projectDir);
  filtered.push(entry);
  write({ entries: filtered });
}

export function unregister(projectDir: string): void {
  const f = read();
  const filtered = f.entries.filter(e => e.projectDir !== projectDir);
  write({ entries: filtered });
}

export function listAll(): RegistryEntry[] {
  return read().entries;
}
