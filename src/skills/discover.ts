/**
 * Skill discovery — walks src/skills/ at boot, loads each bundle's
 * tool.ts, returns the assembled ToolDefinition array.
 *
 * upstream pattern: each skill is a self-contained folder with SKILL.md
 * + tool.ts + (optional) policy.json. Adding a new tool = one new folder,
 * no edits to a central registry.
 *
 * Today this is opt-in. registry-build.ts can choose to fold the
 * discovered skills in alongside the legacy flat tool list. As legacy
 * tools migrate to skill bundles, this becomes the canonical path.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "../types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("skills.discover");

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Optional: comma-separated provider names this skill is allowed on. */
  providers?: string;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  tool: ToolDefinition;
  /** Path to the bundle for telemetry / debug. */
  bundleDir: string;
}

/**
 * Walk src/skills/, load every bundle that has both SKILL.md and tool.ts.
 * Returns an array ready to splice into the central tool registry.
 *
 * Failure mode is permissive: a bad bundle is logged and skipped, not
 * fatal. Boot continues with the remaining valid bundles.
 */
export async function discoverSkills(): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch (e) {
    logger.warn(`couldn't read skills dir ${SKILLS_DIR}: ${(e as Error).message}`);
    return out;
  }

  for (const entry of entries) {
    const bundleDir = join(SKILLS_DIR, entry);
    let isDir = false;
    try { isDir = statSync(bundleDir).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    const skillMdPath = join(bundleDir, "SKILL.md");
    const toolJsPath = join(bundleDir, "tool.js"); // compiled output
    if (!existsSync(skillMdPath) || !existsSync(toolJsPath)) continue;

    let frontmatter: SkillFrontmatter;
    try {
      const md = readFileSync(skillMdPath, "utf-8");
      frontmatter = parseFrontmatter(md);
    } catch (e) {
      logger.warn(`bundle ${entry}: SKILL.md parse failed: ${(e as Error).message}`);
      continue;
    }

    let toolModule: { default?: ToolDefinition; tool?: ToolDefinition };
    try {
      toolModule = (await import(toolJsPath)) as typeof toolModule;
    } catch (e) {
      logger.warn(`bundle ${entry}: tool.js import failed: ${(e as Error).message}`);
      continue;
    }

    const tool = toolModule.default || toolModule.tool;
    if (!tool || typeof tool !== "object" || !("name" in tool)) {
      logger.warn(`bundle ${entry}: tool.js must export default ToolDefinition or named 'tool'`);
      continue;
    }

    out.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tool,
      bundleDir,
    });
    logger.info(`loaded skill: ${frontmatter.name}`);
  }
  return out;
}

/**
 * Minimal YAML frontmatter parser — enough for SKILL.md's
 * `---\nname: x\ndescription: y\n---` shape. Doesn't try to handle
 * arbitrary YAML; extend as needed.
 */
function parseFrontmatter(md: string): SkillFrontmatter {
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) throw new Error("missing YAML frontmatter");
  const out: Record<string, string> = {};
  for (const line of fmMatch[1].split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.+?)\s*$/i);
    if (m) {
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[m[1]] = val;
    }
  }
  if (!out.name || !out.description) {
    throw new Error("frontmatter missing required: name, description");
  }
  return out as unknown as SkillFrontmatter;
}
