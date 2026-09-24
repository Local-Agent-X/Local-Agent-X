/**
 * Install vendor / community Agent Skills (SKILL.md folders) from a GitHub
 * repo into the workspace import tier, pinned to a commit.
 *
 * This is the in-app counterpart of scripts/import-protocols.mjs (which
 * vendors into src/protocols/bundled/ at build time). Same format, same
 * license gate, same "content verbatim + provenance beside it" shape — but
 * per user, at runtime, into `importedProtocolsDir()`, where loader.ts already
 * reads SKILL.md folders. Nothing new is parsed and nothing new is loaded.
 *
 * Trust model. A skill is INSTALLED, never read live off the network: the
 * model sees only what is on disk, pinned by `source.json` to the commit it
 * was fetched at. `refreshSkill` resolves the ref again and returns a patch;
 * writing it is a separate, approval-gated step (`update`). What a repo ships
 * beyond SKILL.md folders — `.mcp.json`, hooks, agents, commands — is reported
 * and NOT installed: MCP servers go through the user's MCP settings, and
 * hooks/agents would be code the harness runs, which no import may add.
 */

import JSZip from "jszip";
import { createPatch } from "diff";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { importedProtocolsDir } from "./loader.js";
import { parseSkillMd } from "./skill-md-parser.js";
import { isDestructiveCommand } from "../approval-decision.js";
import { createLogger } from "../logger.js";

const logger = createLogger("protocols.skills-install");

/** Same gate as scripts/protocol-sources.json `allowedLicenses`. */
export const ALLOWED_LICENSES = ["MIT", "Apache-2.0", "CC-BY-4.0"] as const;
const SKIP_DIRS = /^(node_modules|\.git|\.github|tests?|__tests__|examples?|spec|templates?|fixtures?)$/i;
const MAX_SKILL_MD_BYTES = 512 * 1024;
const MAX_SIDECAR_BYTES = 1024 * 1024;
const MAX_FILES_PER_SKILL = 40;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const SOURCE_FILE = "source.json";

export interface RepoRef { owner: string; repo: string; ref: string; path?: string }

export interface InstalledSource {
  version: 1;
  repo: string;
  ref: string;
  commit: string;
  /** Skill folder inside the repo, e.g. "skills/vercel-deploy". */
  path: string;
  url: string;
  license: string;
  licenseAssertedBy?: "user";
  installedAt: string;
  files: string[];
  lint: string[];
}

export interface InstallOpts {
  /** "owner/repo", "owner/repo@ref", or a github.com URL (optionally /tree/<ref>/<path>). */
  repo: string;
  ref?: string;
  /** Only install skills under this repo-relative folder. */
  path?: string;
  /** The user's own license assertion when neither frontmatter nor the repo says. */
  license?: string;
  /** Overwrite a folder that was not installed from this repo. */
  force?: boolean;
  /** Resolve, download and classify, but write nothing: the same report the
   *  real install would produce, so a UI can show it before the user commits. */
  dryRun?: boolean;
  /** Install only these skills (by normalized name or repo path). A repo of
   *  eighty skills is a catalog, not a pack; the user picks from it. */
  only?: string[];
  fetchImpl?: typeof fetch;
}

export interface InstalledSkill { name: string; path: string; description: string; files: string[]; warnings: string[] }
export interface InstallReport {
  repo: string; ref: string; commit: string;
  installed: InstalledSkill[];
  skipped: Array<{ path: string; reason: string }>;
  /** Skills the repo has that `only` left out — a count, not noise in `skipped`. */
  notSelected: number;
  notInstalled: { mcpServers: string[]; hooks: number; agents: number; commands: number };
}

export interface RefreshReport {
  name: string; repo: string; ref: string;
  installedCommit: string; upstreamCommit: string; upToDate: boolean;
  changedFiles: string[]; patch: string; applied: boolean;
}

// ── Repo reference ────────────────────────────────────────────────────────

export function parseRepoRef(input: string, ref?: string, path?: string): RepoRef {
  const s = input.trim();
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(.+?))?)?\/?$/i);
  const slug = url ? null : s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:@([^\s/]+))?$/);
  const m = url ?? slug;
  if (!m) throw new Error(`Not a GitHub repo reference: "${input}" (expected owner/repo, owner/repo@ref, or a github.com URL)`);
  const cleanPath = (path ?? (url ? m[4] : undefined) ?? "").replace(/^\/+|\/+$/g, "");
  return { owner: m[1], repo: m[2], ref: ref?.trim() || m[3] || "HEAD", path: cleanPath || undefined };
}

async function resolveCommit(r: RepoRef, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(r.ref)}`, {
    headers: { Accept: "application/vnd.github.sha", "User-Agent": "lax-skills-install" },
  });
  if (!res.ok) throw new Error(`GitHub could not resolve ${r.owner}/${r.repo}@${r.ref}: HTTP ${res.status}`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GitHub returned an unexpected commit id for ${r.ref}`);
  return sha;
}

async function downloadArchive(r: RepoRef, commit: string, fetchImpl: typeof fetch): Promise<JSZip> {
  const res = await fetchImpl(`https://codeload.github.com/${r.owner}/${r.repo}/zip/${commit}`, {
    headers: { "User-Agent": "lax-skills-install" },
  });
  if (!res.ok) throw new Error(`GitHub archive download failed for ${r.owner}/${r.repo}@${commit.slice(0, 8)}: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error(`Repo archive is ${Math.round(bytes.byteLength / 1048576)} MB; the import cap is ${MAX_ARCHIVE_BYTES / 1048576} MB`);
  return JSZip.loadAsync(bytes, { createFolders: false });
}

// ── Archive walk ──────────────────────────────────────────────────────────

interface ArchiveSkill {
  path: string;
  skillMd: string;
  siblings: Array<{ rel: string; entry: JSZip.JSZipObject }>;
  /** A LICENSE file inside the skill folder itself — how anthropics/skills
   *  and other multi-skill repos license per skill rather than per repo. */
  license: string | null;
}
interface ArchiveScan { skills: ArchiveSkill[]; license: string | null; notInstalled: InstallReport["notInstalled"] }

function unsafeEntryName(name: string): boolean {
  const n = name.replace(/\\/g, "/");
  return /[\x00-\x1f]/.test(n) || n.startsWith("/") || /^[a-z]:\//i.test(n) || n.split("/").some((p) => p === "..");
}

function detectLicense(text: string): string | null {
  if (/Apache License\s*,?\s*Version 2\.0/i.test(text)) return "Apache-2.0";
  if (/Permission is hereby granted, free of charge/i.test(text) && /MIT License/i.test(text)) return "MIT";
  if (/Creative Commons Attribution 4\.0/i.test(text)) return "CC-BY-4.0";
  return null;
}

async function scanArchive(zip: JSZip, onlyPath: string | undefined): Promise<ArchiveScan> {
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  // codeload archives wrap everything in "<repo>-<sha>/".
  const root = entries[0]?.name.split("/")[0] ?? "";
  const rel = (name: string) => name.replace(/\\/g, "/").slice(root.length + 1);
  const skills: ArchiveSkill[] = [];
  const notInstalled: InstallReport["notInstalled"] = { mcpServers: [], hooks: 0, agents: 0, commands: 0 };
  let license: string | null = null;
  for (const entry of entries) {
    // JSZip sanitizes `..` out of `name` and keeps the original beside it;
    // a traversal attempt is a reason to reject the archive, not to trust the cleaned name.
    const original = entry.unsafeOriginalName ?? entry.name;
    if (unsafeEntryName(original) || unsafeEntryName(entry.name)) throw new Error(`Archive entry rejected: ${original}`);
    const r = rel(entry.name);
    const parts = r.split("/");
    if (parts.length === 1 && /^LICENSE(\.(md|txt))?$/i.test(r)) license = detectLicense(await entry.async("string"));
    if (parts.length === 1 && r === ".mcp.json") {
      try { notInstalled.mcpServers = Object.keys((JSON.parse(await entry.async("string")) as { mcpServers?: object }).mcpServers ?? {}); } catch { /* unreadable manifest is just not reported */ }
    }
    if (parts[0] === "hooks" || parts.includes("hooks")) notInstalled.hooks += 1;
    if (parts[0] === "agents") notInstalled.agents += 1;
    if (parts[0] === "commands") notInstalled.commands += 1;
    if (parts.at(-1) !== "SKILL.md") continue;
    if (parts.slice(0, -1).some((p) => SKIP_DIRS.test(p))) continue;
    const dir = parts.slice(0, -1).join("/");
    if (onlyPath && dir !== onlyPath && !dir.startsWith(`${onlyPath}/`)) continue;
    const siblings = entries
      .filter((e) => { const s = rel(e.name); return s.startsWith(`${dir}/`) && s !== r && !unsafeEntryName(s); })
      .map((e) => ({ rel: rel(e.name).slice(dir.length + 1), entry: e }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
    const ownLicense = siblings.find((s) => /^LICENSE(\.(md|txt))?$/i.test(s.rel));
    skills.push({
      path: dir, skillMd: await entry.async("string"), siblings,
      license: ownLicense ? detectLicense(await ownLicense.entry.async("string")) : null,
    });
  }
  return { skills, license, notInstalled };
}

// ── Name, license, lint ───────────────────────────────────────────────────

/** Same normalization as the bundled importer, capped at the nudge's slug width. */
export function normalizeSkillName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 48);
}

/** The Agent Skills spec makes `name` the folder slug. A pack that strays
 *  (title-cased, spaced, missing) would enter the catalog under a name the
 *  nudge cannot carry and `protocol(action:"get")` cannot match exactly, so
 *  the ONE edit the installer makes to upstream content is that line. Refresh
 *  applies the same edit to the upstream copy before diffing. */
export function pinFrontmatterName(skillMd: string, slug: string): string {
  const m = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return `---\nname: ${slug}\n---\n${skillMd}`;
  const fm = m[1];
  if (new RegExp(`^name:[ \\t]*${slug}[ \\t]*$`, "m").test(fm)) return skillMd;
  const nl = m[0].startsWith("---\r\n") ? "\r\n" : "\n";
  const pinned = /^name:.*$/m.test(fm) ? fm.replace(/^name:.*$/m, `name: ${slug}`) : `name: ${slug}${nl}${fm}`;
  const fmStart = (m.index ?? 0) + 3 + nl.length;
  return skillMd.slice(0, fmStart) + pinned + skillMd.slice(fmStart + fm.length);
}

function licenseAllowed(license: string | null | undefined): boolean {
  return !!license && ALLOWED_LICENSES.some((a) => license.toLowerCase().includes(a.toLowerCase()));
}

const OVERRIDE_PHRASES = /\b(without (asking|confirmation|approval)|do not ask (for|the user)|skip (the )?(confirmation|approval)|ignore (the |any |all )?(previous|prior|system|above) (instructions?|rules?|prompt)|disable (the )?sandbox|never ask (for )?permission)\b/i;

/** Warnings, never a block: a skill body that asks the model to step around a
 *  harness rule (approvals, the irreversible-op floor, the system prompt) is
 *  installed with the warning beside it so the user sees it in the report and
 *  in source.json — the rules themselves still apply at run time. */
export function lintSkillBody(body: string): string[] {
  const out: string[] = [];
  const fenced = body.match(/```[\s\S]*?```/g) ?? [];
  for (const block of fenced) {
    for (const line of block.split("\n").slice(1, -1)) {
      const reason = isDestructiveCommand("bash", { command: line.trim() });
      if (reason) out.push(`destructive command in an example: ${line.trim().slice(0, 80)}`);
    }
  }
  const m = body.match(OVERRIDE_PHRASES);
  if (m) out.push(`asks to bypass a harness rule: "${m[0]}"`);
  return [...new Set(out)];
}

// ── Install ───────────────────────────────────────────────────────────────

export function readInstalledSource(dir: string): InstalledSource | null {
  const file = join(dir, SOURCE_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as InstalledSource;
    return parsed && parsed.version === 1 && typeof parsed.repo === "string" ? parsed : null;
  } catch { return null; }
}

export function listInstalledSkills(): Array<{ name: string; source: InstalledSource }> {
  const root = importedProtocolsDir();
  if (!existsSync(root)) return [];
  const out: Array<{ name: string; source: InstalledSource }> = [];
  for (const name of readdirSync(root)) {
    const source = readInstalledSource(join(root, name));
    if (source) out.push({ name, source });
  }
  return out;
}

async function writeSkill(dir: string, skill: ArchiveSkill, source: Omit<InstalledSource, "files" | "lint">, lint: string[]): Promise<string[]> {
  const files = ["SKILL.md"];
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skill.skillMd, "utf-8");
  for (const sib of skill.siblings.slice(0, MAX_FILES_PER_SKILL - 1)) {
    const bytes = await sib.entry.async("nodebuffer");
    if (bytes.byteLength > MAX_SIDECAR_BYTES) continue;
    const target = join(dir, ...sib.rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    files.push(sib.rel);
  }
  const record: InstalledSource = { ...source, files, lint };
  writeFileSync(join(dir, SOURCE_FILE), JSON.stringify(record, null, 2) + "\n", "utf-8");
  return files;
}

export async function installSkills(opts: InstallOpts): Promise<InstallReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const r = parseRepoRef(opts.repo, opts.ref, opts.path);
  const commit = await resolveCommit(r, fetchImpl);
  const scan = await scanArchive(await downloadArchive(r, commit, fetchImpl), r.path);
  const repo = `${r.owner}/${r.repo}`;
  const report: InstallReport = { repo, ref: r.ref, commit, installed: [], skipped: [], notSelected: 0, notInstalled: scan.notInstalled };
  const only = opts.only ? new Set(opts.only.map((s) => s.trim())) : null;
  const root = importedProtocolsDir();
  for (const skill of scan.skills) {
    if (Buffer.byteLength(skill.skillMd) > MAX_SKILL_MD_BYTES) { report.skipped.push({ path: skill.path, reason: "SKILL.md over 512 KB" }); continue; }
    const parsed = parseSkillMd(skill.skillMd, { source: { type: "imported" }, fallbackName: skill.path.split("/").at(-1) });
    if (!parsed) { report.skipped.push({ path: skill.path, reason: "no usable name or body" }); continue; }
    const name = normalizeSkillName(parsed.name);
    if (!name) { report.skipped.push({ path: skill.path, reason: `name "${parsed.name}" normalizes to nothing` }); continue; }
    if (only && !only.has(name) && !only.has(skill.path)) { report.notSelected += 1; continue; }
    // Precedence: the skill's own frontmatter, a LICENSE inside its folder, the
    // repo's root LICENSE, then the user's assertion — the only one recorded as
    // such. A frontmatter value that merely points at a file ("Complete terms
    // in LICENSE.txt", the anthropics/skills convention) is a pointer, not a
    // license: it defers to the file it names.
    const frontmatter = parsed.source?.license?.trim() || null;
    const pointer = !!frontmatter && /\bLICENSE\b/i.test(frontmatter) && !licenseAllowed(frontmatter);
    const declared = (pointer ? null : frontmatter) || skill.license || scan.license || null;
    const license = declared || opts.license?.trim() || null;
    if (!licenseAllowed(license)) {
      const shown = license ?? (pointer ? frontmatter : null);
      report.skipped.push({ path: skill.path, reason: shown ? `license "${shown}" is not one of ${ALLOWED_LICENSES.join("/")}` : `no license found (frontmatter, the skill folder, or the repo root); pass license:"MIT" to assert one` });
      continue;
    }
    const dir = join(root, name);
    const existing = readInstalledSource(dir);
    if (existsSync(dir) && !opts.force && (!existing || existing.repo !== repo)) {
      report.skipped.push({ path: skill.path, reason: existing ? `"${name}" is installed from ${existing.repo}; pass force:true to replace it` : `"${name}" exists in the workspace and was not installed from a repo; pass force:true to replace it` });
      continue;
    }
    const lint = lintSkillBody(parsed.body ?? "");
    const files = opts.dryRun
      ? ["SKILL.md", ...skill.siblings.slice(0, MAX_FILES_PER_SKILL - 1).map((s) => s.rel)]
      : await writeSkill(dir, { ...skill, skillMd: pinFrontmatterName(skill.skillMd, name) }, {
        version: 1, repo, ref: r.ref, commit, path: skill.path,
        url: `https://github.com/${repo}/tree/${commit}/${skill.path}`,
        license: license!, ...(declared ? {} : { licenseAssertedBy: "user" as const }),
        installedAt: new Date().toISOString(),
      }, lint);
    report.installed.push({ name, path: skill.path, description: parsed.description, files, warnings: lint });
  }
  if (!opts.dryRun) logger.info(`[skills] ${repo}@${commit.slice(0, 8)}: installed ${report.installed.length}, skipped ${report.skipped.length}`);
  return report;
}

/** Remove an installed pack. Only a folder carrying install provenance goes;
 *  a hand-written SKILL.md in the same directory is the user's and is refused. */
export function removeInstalledSkill(name: string): { name: string; repo: string } {
  const slug = normalizeSkillName(name);
  const dir = join(importedProtocolsDir(), slug);
  const source = readInstalledSource(dir);
  if (!source) throw new Error(`"${name}" is not a skill installed from a repo (no ${SOURCE_FILE}); remove it by hand if it is yours`);
  rmSync(dir, { recursive: true, force: true });
  logger.info(`[skills] removed ${slug} (${source.repo}@${source.commit.slice(0, 8)})`);
  return { name: slug, repo: source.repo };
}

// ── Refresh ───────────────────────────────────────────────────────────────

export async function refreshSkill(name: string, opts: { apply?: boolean; fetchImpl?: typeof fetch } = {}): Promise<RefreshReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const dir = join(importedProtocolsDir(), normalizeSkillName(name));
  const source = readInstalledSource(dir);
  if (!source) throw new Error(`"${name}" is not a skill installed from a repo (no ${SOURCE_FILE})`);
  const r = parseRepoRef(source.repo, source.ref, source.path);
  const upstreamCommit = await resolveCommit(r, fetchImpl);
  const base = { name, repo: source.repo, ref: source.ref, installedCommit: source.commit, upstreamCommit, applied: false };
  if (upstreamCommit === source.commit) return { ...base, upToDate: true, changedFiles: [], patch: "" };
  const scan = await scanArchive(await downloadArchive(r, upstreamCommit, fetchImpl), source.path);
  const found = scan.skills.find((s) => s.path === source.path);
  if (!found) throw new Error(`${source.repo}@${upstreamCommit.slice(0, 8)} no longer has a skill at ${source.path}`);
  const slug = normalizeSkillName(name);
  const skill: ArchiveSkill = { ...found, skillMd: pinFrontmatterName(found.skillMd, slug) };
  const current = readFileSync(join(dir, "SKILL.md"), "utf-8");
  const changedFiles: string[] = [];
  if (current !== skill.skillMd) changedFiles.push("SKILL.md");
  const upstreamFiles = new Set(["SKILL.md", ...skill.siblings.map((s) => s.rel)]);
  for (const f of source.files) if (!upstreamFiles.has(f)) changedFiles.push(`${f} (removed upstream)`);
  for (const f of upstreamFiles) if (!source.files.includes(f)) changedFiles.push(`${f} (added upstream)`);
  const patch = current === skill.skillMd ? "" : createPatch(`${name}/SKILL.md`, current, skill.skillMd, source.commit.slice(0, 8), upstreamCommit.slice(0, 8), { context: 3 });
  if (!opts.apply) return { ...base, upToDate: false, changedFiles, patch };
  const parsed = parseSkillMd(skill.skillMd, { source: { type: "imported" }, fallbackName: name });
  const lint = lintSkillBody(parsed?.body ?? "");
  await writeSkill(dir, skill, {
    version: 1, repo: source.repo, ref: source.ref, commit: upstreamCommit, path: source.path,
    url: `https://github.com/${source.repo}/tree/${upstreamCommit}/${source.path}`,
    license: source.license, ...(source.licenseAssertedBy ? { licenseAssertedBy: source.licenseAssertedBy } : {}),
    installedAt: new Date().toISOString(),
  }, lint);
  return { ...base, upToDate: false, changedFiles, patch, applied: true };
}
