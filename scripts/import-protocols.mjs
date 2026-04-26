#!/usr/bin/env node
/**
 * Bulk SKILL.md → protocols/bundled/ importer.
 *
 * Reads scripts/protocol-sources.json, shallow-clones each source repo into
 * .protocol-import-cache/, walks for SKILL.md files, validates frontmatter +
 * license, dedupes by name (priority order), copies into protocols/bundled/<name>/,
 * and writes protocols/bundled/INDEX.json with provenance.
 *
 * Usage:
 *   node scripts/import-protocols.mjs                 # full import
 *   node scripts/import-protocols.mjs --dry-run       # report only
 *   node scripts/import-protocols.mjs --refresh       # delete cache, re-clone
 *
 * Constraints:
 *   - Stays under 400 LOC.
 *   - No npm deps. Uses node:fs, node:child_process for git clone.
 *   - Idempotent: re-running with the same cache produces the same output.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, cpSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CACHE_DIR = join(REPO_ROOT, ".protocol-import-cache");
const TARGET_DIR = join(REPO_ROOT, "protocols", "bundled");
const SOURCES_PATH = join(REPO_ROOT, "scripts", "protocol-sources.json");

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has("--dry-run");
const REFRESH = argv.has("--refresh");

function log(...a) { console.log("[import]", ...a); }
function warn(...a) { console.warn("[import] WARN", ...a); }

// ── Frontmatter parser (same shape as src/protocols/skill-md-parser.ts) ───

function parseFrontmatter(content) {
  // Normalize line endings so the per-line regex below isn't tripped by CRLF.
  content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  let currentKey = "";
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const v = kv[2].trim();
      if (v.startsWith("[") && v.endsWith("]")) {
        meta[currentKey] = v.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
      } else if (v) {
        meta[currentKey] = v.replace(/^["']|["']$/g, "");
      }
    } else if (currentKey && line.match(/^\s+-\s+(.+)/)) {
      const item = line.match(/^\s+-\s+(.+)/)?.[1]?.trim();
      if (item) {
        const ex = meta[currentKey];
        if (Array.isArray(ex)) ex.push(item);
        else meta[currentKey] = [item];
      }
    }
  }
  return { meta, body: match[2].trim() };
}

// ── Repo cloning ──────────────────────────────────────────────────────────

function cloneSource(source) {
  const dest = join(CACHE_DIR, source.id);
  if (REFRESH && existsSync(dest)) {
    log(`refresh: removing ${dest}`);
    rmSync(dest, { recursive: true, force: true });
  }
  if (existsSync(dest)) {
    log(`cached: ${source.id} (use --refresh to re-clone)`);
    return dest;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const url = `https://github.com/${source.repo}.git`;
  log(`cloning ${source.repo}@${source.ref} → ${dest}`);
  try {
    execSync(`git clone --depth 1 --branch ${source.ref} ${url} "${dest}"`, { stdio: "inherit" });
  } catch (e) {
    warn(`clone failed for ${source.repo}: ${e.message}`);
    return null;
  }
  return dest;
}

function getCommitSha(dir) {
  try {
    return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

// ── Scanning ──────────────────────────────────────────────────────────────

function shouldExclude(relPath, excludeList) {
  if (!excludeList || excludeList.length === 0) return false;
  const segments = relPath.split(sep);
  return excludeList.some(ex => segments.includes(ex));
}

function findSkillMd(rootDir, source) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(rootDir, full);
      if (shouldExclude(rel, source.excludePaths)) continue;
      if (e.isDirectory()) {
        // If `paths` is non-empty, only walk inside listed subdirs.
        if (source.paths && source.paths.length > 0) {
          const inAllowed = source.paths.some(p => rel === p || rel.startsWith(p + sep));
          if (!inAllowed && !source.paths.some(p => p.startsWith(rel + sep))) continue;
        }
        if (e.name === ".git") continue;
        walk(full);
      } else if (e.isFile() && e.name === "SKILL.md") {
        found.push(full);
      }
    }
  };
  walk(rootDir);
  return found;
}

function normalizeName(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

// ── License gating ────────────────────────────────────────────────────────

function isLicenseAllowed(license, allowed) {
  if (!license) return false;
  return allowed.some(a => license.toLowerCase().includes(a.toLowerCase()));
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(SOURCES_PATH)) { warn(`missing ${SOURCES_PATH}`); process.exit(1); }
  const cfg = JSON.parse(readFileSync(SOURCES_PATH, "utf-8"));
  const allowedLicenses = cfg.allowedLicenses || ["MIT", "Apache-2.0"];
  const sources = (cfg.sources || []).slice().sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

  if (DRY_RUN) log("DRY RUN — no files will be written");

  const candidates = []; // { name, source, file, body, meta, sourcePriority }
  let scanned = 0, frontmatterRejected = 0, licenseRejected = 0;

  for (const source of sources) {
    const root = cloneSource(source);
    if (!root) continue;
    const commit = getCommitSha(root);
    const files = findSkillMd(root, source);
    log(`${source.id}: scanning ${files.length} SKILL.md files`);
    for (const file of files) {
      scanned += 1;
      let raw;
      try { raw = readFileSync(file, "utf-8"); } catch { continue; }
      const { meta, body } = parseFrontmatter(raw);
      if (!meta.name && !body) { frontmatterRejected += 1; continue; }
      const license = (typeof meta.license === "string" ? meta.license : null) || source.license;
      if (!isLicenseAllowed(license, allowedLicenses)) {
        licenseRejected += 1;
        continue;
      }
      const fallbackName = normalizeName(file.split(sep).slice(-2, -1)[0]);
      const name = normalizeName(meta.name || fallbackName);
      if (!name) continue;
      candidates.push({
        name, source, file, body, meta,
        sourcePriority: source.priority ?? 99,
        commit, license,
      });
    }
  }

  // Dedup — keep lowest priority value per name (= highest source priority).
  const byName = new Map();
  let dedupCollisions = 0;
  for (const c of candidates) {
    const ex = byName.get(c.name);
    if (!ex || c.sourcePriority < ex.sourcePriority) {
      if (ex) dedupCollisions += 1;
      byName.set(c.name, c);
    } else {
      dedupCollisions += 1;
    }
  }

  log(`scanned: ${scanned}`);
  log(`rejected (frontmatter): ${frontmatterRejected}`);
  log(`rejected (license): ${licenseRejected}`);
  log(`dedup collisions resolved: ${dedupCollisions}`);
  log(`final unique protocols: ${byName.size}`);

  if (DRY_RUN) {
    log("DRY RUN complete — no writes performed");
    return;
  }

  mkdirSync(TARGET_DIR, { recursive: true });

  // Preserve hand-bundled entries we don't want to clobber.
  const PRESERVED = new Set(["credentialed-integration-setup", "git-status", "summarize"]);

  // Wipe stale entries from prior imports (anything with a bundle_meta in INDEX.json
  // that's no longer in the new candidates). Cheap approach: nuke every dir not
  // in the new set or PRESERVED.
  for (const entry of readdirSync(TARGET_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (PRESERVED.has(entry.name)) continue;
    if (byName.has(entry.name)) continue;
    rmSync(join(TARGET_DIR, entry.name), { recursive: true, force: true });
  }

  const index = [];
  let written = 0;

  for (const [name, c] of byName) {
    if (PRESERVED.has(name)) continue;
    const destDir = join(TARGET_DIR, name);
    mkdirSync(destDir, { recursive: true });

    // Write SKILL.md with bundle_meta injected. Keep upstream content verbatim;
    // just append a metadata block at the end of the frontmatter.
    const bundleMeta = {
      source_repo: c.source.repo,
      source_commit: c.commit || "",
      source_license: c.license || "",
      attribution: c.source.attribution || "",
      imported_at: new Date().toISOString(),
    };
    const augmented = injectBundleMeta(readFileSync(c.file, "utf-8"), bundleMeta);
    writeFileSync(join(destDir, "SKILL.md"), augmented, "utf-8");

    // Best-effort copy of sibling resources/scripts/references dirs.
    const srcDir = c.file.replace(/\/SKILL\.md$|\\SKILL\.md$/, "");
    for (const sib of ["resources", "references", "scripts"]) {
      const from = join(srcDir, sib);
      if (existsSync(from) && statSync(from).isDirectory()) {
        try { cpSync(from, join(destDir, sib), { recursive: true }); } catch (e) { warn(`copy ${sib} for ${name}: ${e.message}`); }
      }
    }

    written += 1;
    index.push({
      name,
      description: typeof c.meta.description === "string" ? c.meta.description : "",
      category: typeof c.meta.category === "string" ? c.meta.category : undefined,
      tags: Array.isArray(c.meta.tags) ? c.meta.tags : undefined,
      source: { type: "bundled", repo: c.source.repo, commit: c.commit, license: c.license, attribution: c.source.attribution },
    });
  }

  writeFileSync(join(TARGET_DIR, "INDEX.json"), JSON.stringify(index, null, 2), "utf-8");
  log(`wrote ${written} protocols to ${TARGET_DIR}`);
  log(`wrote INDEX.json with ${index.length} entries`);
}

function injectBundleMeta(raw, meta) {
  const block = [
    "bundle_meta:",
    `  source_repo: ${meta.source_repo}`,
    `  source_commit: ${meta.source_commit}`,
    `  source_license: ${meta.source_license}`,
    `  imported_at: ${meta.imported_at}`,
    meta.attribution ? `  attribution: "${meta.attribution.replace(/"/g, '\\"')}"` : "",
  ].filter(Boolean).join("\n");

  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    return `---\n${block}\n---\n\n${raw}`;
  }
  return `---\n${fmMatch[1]}\n${block}\n---\n${fmMatch[2]}`;
}

main();
