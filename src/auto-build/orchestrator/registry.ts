/**
 * Active-orchestrator registry — tracks every project_dir that has an
 * in-flight build so the LAX boot scanner can find and auto-resume them.
 *
 * Lives at `~/.lax/active-orchestrators.json`. Format:
 *   { entries: [{ projectDir, opId, sessionId, registeredAt }, ...] }
 *
 * Distinct from each project's `.lax-build-run.json` — that
 * file is the canonical state (used to resume). The registry is just a
 * pointer list so the boot scanner doesn't have to scan the entire
 * filesystem looking for state files.
 *
 * Registration is load-bearing: a build cannot report running unless
 * this discovery pointer is durably written.
 */

import { existsSync, readFileSync } from "node:fs";
import { getLaxDir } from "../../lax-data-dir.js";
import { join } from "node:path";
import { atomicWriteFileSync, ensureDirFor } from "../../util/json-store.js";

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
  return join(getLaxDir(), "active-orchestrators.json");
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

function write(file: RegistryFile): boolean {
  const p = registryPath();
  try {
    ensureDirFor(p);
    atomicWriteFileSync(p, JSON.stringify(file, null, 2));
    return true;
  } catch (error) {
    process.stderr.write(`[orchestrator-registry] write failed: ${(error as Error).message}\n`);
    return false;
  }
}

export function register(entry: RegistryEntry): boolean {
  const f = read();
  // Replace any existing entry for the same projectDir (one build per dir at a time).
  const filtered = f.entries.filter(e => e.projectDir !== entry.projectDir);
  filtered.push(entry);
  return write({ entries: filtered });
}

export function unregister(projectDir: string): boolean {
  const f = read();
  const filtered = f.entries.filter(e => e.projectDir !== projectDir);
  return write({ entries: filtered });
}

export function listAll(): RegistryEntry[] {
  return read().entries;
}
