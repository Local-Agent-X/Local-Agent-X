/**
 * Three-tier protocol loader.
 *
 *   1. Built-in packs   — typed Protocol records in src/protocols/packs/*.ts.
 *                          Stamped with source.type = "builtin" if missing.
 *   2. Bundled imports  — SKILL.md files vendored at src/protocols/bundled/<name>/.
 *                          Parsed via parseSkillMd(); source.type = "bundled".
 *                          Ships with the app (e.g. the app-build / senior-engineer
 *                          methodology bodies) and can be extended by running
 *                          scripts/import-protocols.mjs or dropping in a curated
 *                          pack repo. Copied into dist/ at build time by
 *                          scripts/copy-bundled-protocols.mjs so the compiled
 *                          server finds it at the same path-relative location.
 *   3. User overlay     — SKILL.md files in workspace/protocols/imported/<name>/
 *                          plus typed records from ~/.lax/custom-protocols.json.
 *                          source.type = "imported" or "custom".
 *   4. Managed learned  — system-generated SKILL.md files under
 *                          ~/.lax/protocols/learned/<name>/. Loaded after the
 *                          workspace overlay so an
 *                          agent-writable workspace import cannot shadow one.
 *
 * Precedence (later wins on name collision): builtin → bundled →
 * workspace import → managed learned → typed custom.
 * That lets users override anything bundled or built-in by dropping a file
 * with the matching name into ~/.lax/protocols/imported/.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Protocol, ProtocolSource } from "../protocols/index.js";
import { getLaxDir } from "../lax-data-dir.js";
import { parseSkillMd } from "./skill-md-parser.js";
import { getRuntimeConfig } from "../config.js";

import { createLogger } from "../logger.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const logger = createLogger("protocols.loader");

// ── Paths ──────────────────────────────────────────────────────────────────

// Resolve relative to this module, not process.cwd(), so bundled protocols load
// regardless of the launch directory. Lands at src/protocols/bundled in dev and
// dist/protocols/bundled in prod — copy-bundled-protocols.mjs mirrors it into dist.
const HERE = dirname(fileURLToPath(import.meta.url));

/** The one canonical resolver for the vendored bundled-protocol directory.
 *  Every consumer (the tier-2 loader below AND auto-build's
 *  loadSkillBody) imports this — do not recompute the path elsewhere. */
export function bundledProtocolsDir(): string {
  return join(HERE, "bundled");
}

/** Synced user protocol dir — lives in workspace/protocols/imported/.
 *  Picked up by workspace git sync so user-added SKILL.md packs propagate
 *  to all of the user's machines. The ONLY location loaded post-migration. */
export function importedProtocolsDir(): string {
  const cfg = getRuntimeConfig();
  return resolve(cfg.workspace, "protocols", "imported");
}

/** Machine-local trust root for system-managed learned protocols. */
export function learnedProtocolsDir(): string {
  return join(getLaxDir(), "protocols", "learned");
}

function legacySkillsDir(): string {
  return join(getLaxDir(), "skills");
}

/** Pre-2026-05-19 import dir. One-shot migration moves it to workspace
 *  on first load; after that, the dir is gone and nothing scans it. */
function legacyImportedDir(): string {
  return join(getLaxDir(), "protocols", "imported");
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
    target = importedProtocolsDir();
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
  _bundledCache = scanSkillMdDir(bundledProtocolsDir(), "bundled");
  return _bundledCache;
}

/** Drop the bundled cache. Call after the importer writes new files. */
export function invalidateBundledCache(): void {
  _bundledCache = null;
}

export function loadImportedProtocols(): Protocol[] {
  runProtocolMigrations();
  const userImports = scanSkillMdDir(importedProtocolsDir(), "imported");
  const managedLearned = scanSkillMdDir(learnedProtocolsDir(), "imported");
  return mergeByName(userImports, managedLearned);
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
