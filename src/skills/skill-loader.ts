/**
 * Skill Loader — scans directories for SKILL.md files and parses them.
 *
 * Search order (first occurrence wins):
 *   1. ~/.sax/skills/{name}/SKILL.md
 *   2. workspace/.sax/skills/{name}/SKILL.md
 *   3. .sax/skills/{name}/SKILL.md (project root)
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Skill, SkillMetadata } from "./skill-types.js";

/** Parse YAML-like frontmatter from markdown. Simple key: value parser — no deps needed. */
function parseFrontmatter(content: string): { meta: Record<string, string | string[]>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string | string[]> = {};
  let currentKey = "";
  for (const line of match[1].split("\n")) {
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        // Inline array: [Read, Grep, Bash]
        meta[currentKey] = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      } else if (val) {
        meta[currentKey] = val.replace(/^["']|["']$/g, "");
      }
    } else if (currentKey && line.match(/^\s+-\s+(.+)/)) {
      // YAML list item
      const item = line.match(/^\s+-\s+(.+)/)?.[1]?.trim();
      if (item) {
        const existing = meta[currentKey];
        if (Array.isArray(existing)) existing.push(item);
        else meta[currentKey] = [item];
      }
    }
  }
  return { meta, body: match[2].trim() };
}

function loadSkillFromDir(dir: string, id: string): Skill | null {
  const filePath = join(dir, "SKILL.md");
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    if (!body) return null;

    const metadata: SkillMetadata = {
      name: (meta.name as string) || id,
      description: (meta.description as string) || `Skill: ${id}`,
      allowedTools: Array.isArray(meta["allowed-tools"]) ? meta["allowed-tools"] : undefined,
      argumentHint: meta["argument-hint"] as string | undefined,
      whenToUse: meta["when-to-use"] as string | undefined,
    };

    return { id, metadata, body, sourcePath: filePath };
  } catch {
    return null;
  }
}

function scanSkillDir(baseDir: string): Skill[] {
  if (!existsSync(baseDir)) return [];
  const skills: Skill[] = [];
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skill = loadSkillFromDir(join(baseDir, entry.name), entry.name);
      if (skill) skills.push(skill);
    }
  } catch { /* directory not readable */ }
  return skills;
}

/** Seed bundled skills from repo into ~/.sax/skills/ if not already present */
function seedBundledSkills(): void {
  const userSkillsDir = join(homedir(), ".lax", "skills");
  // Look for bundled skills in the repo root
  const bundledDir = join(process.cwd(), "skills");
  if (!existsSync(bundledDir)) return;

  try {
    for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const destDir = join(userSkillsDir, entry.name);
      const destFile = join(destDir, "SKILL.md");
      if (existsSync(destFile)) continue; // don't overwrite user modifications
      const srcFile = join(bundledDir, entry.name, "SKILL.md");
      if (!existsSync(srcFile)) continue;
      mkdirSync(destDir, { recursive: true });
      copyFileSync(srcFile, destFile);
      console.log(`[skills] Seeded bundled skill: ${entry.name}`);
    }
  } catch (e) {
    console.warn(`[skills] Failed to seed bundled skills: ${(e as Error).message}`);
  }
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private workspaceDir?: string;

  /** Scan all skill directories and load skills (first occurrence wins) */
  load(workspaceDir?: string): void {
    this.workspaceDir = workspaceDir;
    seedBundledSkills();
    this.reload();
  }

  /** Reload skills from disk (call after editing skill files) */
  reload(): void {
    this.skills.clear();
    const dirs = [
      join(homedir(), ".lax", "skills"),
      ...(this.workspaceDir ? [join(this.workspaceDir, ".lax", "skills")] : []),
      join(process.cwd(), ".lax", "skills"),
    ];

    for (const dir of dirs) {
      for (const skill of scanSkillDir(dir)) {
        if (!this.skills.has(skill.id)) {
          this.skills.set(skill.id, skill);
        }
      }
    }
    if (this.skills.size > 0) console.log(`[skills] Loaded ${this.skills.size} skills`);
  }

  get(id: string): Skill | undefined { return this.skills.get(id); }

  list(): Skill[] { return [...this.skills.values()]; }

  /** Build a prompt from a skill with argument substitution */
  buildPrompt(skill: Skill, args?: string): string {
    let prompt = skill.body;
    if (args) {
      prompt = prompt.replace(/\$ARGUMENTS/g, args);
    }
    return prompt;
  }
}

let _registry: SkillRegistry | null = null;
export function getSkillRegistry(workspaceDir?: string): SkillRegistry {
  if (!_registry) { _registry = new SkillRegistry(); _registry.load(workspaceDir); }
  return _registry;
}
