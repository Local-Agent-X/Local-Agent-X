/**
 * Three-tier protocol loader.
 *
 *   1. Built-in packs   — typed Protocol records in src/protocols/packs/*.ts.
 *                          Stamped with source.type = "builtin" if missing.
 *   2. Bundled imports  — SKILL.md files vendored at protocols/bundled/<name>/.
 *                          Parsed via parseSkillMd(); source.type = "bundled".
 *                          The default install ships with this directory empty
 *                          (or absent) — bundled is an optional layer that
 *                          users can populate by running scripts/import-protocols.mjs
 *                          or by dropping in a curated pack repo.
 *   3. User overlay     — SKILL.md files at ~/.lax/protocols/imported/<name>/
 *                          plus typed records from ~/.lax/custom-protocols.json.
 *                          source.type = "imported" or "custom".
 *
 * Precedence (later wins on name collision): builtin → bundled → user.
 * That lets users override anything bundled or built-in by dropping a file
 * with the matching name into ~/.lax/protocols/imported/.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Protocol, ProtocolSource } from "../protocols.js";
import { parseSkillMd } from "./skill-md-parser.js";
import { getRuntimeConfig } from "../config.js";

import { createLogger } from "../logger.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const logger = createLogger("protocols.loader");

// ── Paths ──────────────────────────────────────────────────────────────────

function bundledDir(): string {
  return join(process.cwd(), "protocols", "bundled");
}

/** Synced user protocol dir — lives in workspace/protocols/imported/.
 *  Picked up by workspace git sync so user-added SKILL.md packs propagate
 *  to all of the user's machines. The ONLY location loaded post-migration. */
function workspaceImportedDir(): string {
  const cfg = getRuntimeConfig();
  return resolve(cfg.workspace, "protocols", "imported");
}

function legacySkillsDir(): string {
  return join(homedir(), ".lax", "skills");
}

/** Pre-2026-05-19 import dir. One-shot migration moves it to workspace
 *  on first load; after that, the dir is gone and nothing scans it. */
function legacyImportedDir(): string {
  return join(homedir(), ".lax", "protocols", "imported");
}

// ── One-time migrations into workspace/protocols/imported/ ─────────────────
//
// Two legacy locations existed before protocols moved into the workspace:
//   1. ~/.lax/skills/                — earliest layout
//   2. ~/.lax/protocols/imported/    — intermediate layout (pre-2026-05-19)
//
// Both fold into workspace/protocols/imported/ on first load. Idempotent
// (renameSync is the no-op when source is gone) and best-effort (any
// permission/cross-device failure skips that entry without throwing).

let _migrationRan = false;

function runProtocolMigrations(): void {
  if (_migrationRan) return;
  _migrationRan = true;

  let target: string;
  try {
    target = workspaceImportedDir();
  } catch {
    // Config not initialized yet (rare early-boot path) — defer.
    _migrationRan = false;
    return;
  }

  for (const legacy of [legacySkillsDir(), legacyImportedDir()]) {
    if (!existsSync(legacy)) continue;
    try {
      mkdirSync(target, { recursive: true });
      let moved = 0;
      for (const entry of readdirSync(legacy, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const src = join(legacy, entry.name);
        const dst = join(target, entry.name);
        if (existsSync(dst)) continue; // workspace already has one — keep it
        try { renameSync(src, dst); moved += 1; } catch { /* cross-device / permission — skip */ }
      }
      if (moved > 0) {
        logger.info(`[protocols] Migrated ${moved} pack(s) from ${legacy} → ${target}`);
      }
      // Best-effort cleanup of the now-empty legacy dir.
      try {
        if (readdirSync(legacy).length === 0) {
          const fs = require("node:fs") as typeof import("node:fs");
          fs.rmdirSync(legacy);
        }
      } catch { /* leave it */ }
    } catch (e) {
      logger.warn(`[protocols] Migration from ${legacy} failed: ${(e as Error).message}`);
    }
  }
}

// ── SKILL.md directory scanning ───────────────────────────────────────────

function scanSkillMdDir(dir: string, sourceType: "bundled" | "imported"): Protocol[] {
  if (!existsSync(dir)) return [];
  const out: Protocol[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    const subdir = join(dir, name);
    let isDir = false;
    try { isDir = statSync(subdir).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    const skillFile = join(subdir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let raw: string;
    try { raw = readFileSync(skillFile, "utf-8"); } catch { continue; }
    const source: ProtocolSource = { type: sourceType, sourcePath: skillFile };
    const protocol = parseSkillMd(raw, { source, fallbackName: name });
    if (protocol) out.push(protocol);
  }
  return out;
}

// ── Cache layer ────────────────────────────────────────────────────────────
//
// Bundled protocols are cached in memory: the directory only changes when
// the importer runs, which is rare. The default install has zero bundled
// SKILL.md files, but a user-populated pack can grow large, so caching
// keeps boot fast. Imported (user) layer is read every call — users edit
// those frequently and the count is always small.

let _bundledCache: Protocol[] | null = null;

export function loadBundledProtocols(): Protocol[] {
  if (_bundledCache) return _bundledCache;
  _bundledCache = scanSkillMdDir(bundledDir(), "bundled");
  return _bundledCache;
}

/** Drop the bundled cache. Call after the importer writes new files. */
export function invalidateBundledCache(): void {
  _bundledCache = null;
}

export function loadImportedProtocols(): Protocol[] {
  runProtocolMigrations();
  return scanSkillMdDir(workspaceImportedDir(), "imported");
}

// ── Stamping helpers ──────────────────────────────────────────────────────

/** Stamp source.type = "builtin" on packs that don't already declare a source. */
export function stampBuiltinSource(packs: Protocol[]): Protocol[] {
  return packs.map((p) => p.source ? p : { ...p, source: { type: "builtin" as const } });
}

/** Stamp source.type = "custom" on user-defined typed records. */
export function stampCustomSource(records: Protocol[]): Protocol[] {
  return records.map((p) => p.source ? p : { ...p, source: { type: "custom" as const } });
}

// ── Merge ─────────────────────────────────────────────────────────────────

/**
 * Merge a precedence-ordered list of protocol arrays. Later arrays override
 * earlier ones on name collision. Order should be:
 *   [builtin, bundled, imported, custom]
 */
export function mergeByName(...sources: Protocol[][]): Protocol[] {
  const byName = new Map<string, Protocol>();
  for (const arr of sources) {
    for (const p of arr) {
      if (!p?.name) continue;
      byName.set(p.name, p);
    }
  }
  return [...byName.values()];
}

/** Run the legacy migrations on first boot — call once during server lifecycle. */
export function bootProtocolsLayer(): void {
  runProtocolMigrations();
}
