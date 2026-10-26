#!/usr/bin/env node
/**
 * Bundled-skill gate for the skills Local Agent X ships from the owner's own
 * Claude Code skills (~/.claude/skills): senior-engineer, canonical-check and
 * blast-radius under src/protocols/bundled/. The skill is the source of truth;
 * the bundled copy is that text with its Claude Code tool names swapped for
 * LAX's (ADAPTATIONS), so it is never hand-edited.
 *
 * The copy drifts two ways, and this catches both:
 *   1. Hand edits here. UPSTREAM.json beside each SKILL.md records the sha256 of
 *      the bundled text (line endings folded to LF). A changed hash fails.
 *   2. The skill moving on. When it is found ($CLAUDE_SKILLS_DIR, else
 *      ~/.claude/skills), the bundled text must equal the adapted skill.
 *      Without it (CI, an install, another machine) this half is skipped, loudly.
 * Every adaptation must still match the skill's wording: a reworded line fails
 * here instead of shipping Claude Code's tool names to LAX's agent.
 *
 *   --sync   adapt every skill into the bundle and record the hashes. The only
 *            way these SKILL.md files should change.
 * Runs in `npm run build` (check:skill-sync).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const BUNDLED_DIR = join(repoRoot, "src", "protocols", "bundled");
export const SYNCED_SKILLS = ["senior-engineer", "canonical-check", "blast-radius"];

/** Claude Code tool → LAX tool, for the frontmatter's allowed-tools list. */
export const TOOL_NAMES = {
  Read: "read", Write: "write", Edit: "edit", Glob: "glob", Grep: "grep", Bash: "bash",
  Agent: "agent_spawn", AskUserQuestion: "ask_user",
};

// The read-only Explore agent Claude Code delegates searches to is, in LAX, an
// agent_spawn of the reviewer role: it reads files and runs shell, never edits.
const HELPER = "read-only helper agent (`agent_spawn` with the `reviewer` role)";

/** Body phrases that name a Claude Code tool, and what LAX's agent reads instead. */
export const ADAPTATIONS = {
  "senior-engineer": [
    ["- `Glob` to find candidates, `Grep` to confirm.", "- `glob` to find candidates, `grep` to confirm."],
  ],
  "canonical-check": [
    ["- Glob the expected anchor", "- `glob` the expected anchor"],
    ["- Grep for the responsibility verbs", "- `grep` for the responsibility verbs"],
    ['a **single** Explore sub-agent (breadth "medium")', `a **single** ${HELPER}`],
    ["Always Glob + Grep before", "Always `glob` + `grep` before"],
  ],
  "blast-radius": [
    ["- `Grep` the symbol name", "- `grep` the symbol name"],
    ['a **single** Explore agent (breadth "medium")', `a **single** ${HELPER}`],
  ],
};

const lf = (text) => text.replace(/\r\n/g, "\n");
const hashOf = (text) => createHash("sha256").update(text).digest("hex");

/** The skill's text as LAX ships it. Throws on a tool or phrase it cannot map. */
export function adaptSkill(name, text) {
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---") || end < 0) throw new Error(`${name}: no frontmatter`);
  const front = text.slice(0, end).replace(/^(\s+- )(\S+)$/gm, (line, lead, tool) => {
    if (!(tool in TOOL_NAMES)) throw new Error(`${name}: allowed-tools names ${tool}, which TOOL_NAMES does not map to a LAX tool`);
    return lead + TOOL_NAMES[tool];
  });
  let body = text.slice(end);
  for (const [from, to] of ADAPTATIONS[name] ?? []) {
    if (!body.includes(from)) throw new Error(`${name}: the skill no longer says "${from}"; update ADAPTATIONS in scripts/check-skill-sync.mjs`);
    body = body.split(from).join(to);
  }
  return front + body;
}

/** Where the owner's skills are, or null when this machine has none. */
export function findSkillsDir() {
  const dir = process.env.CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
  return SYNCED_SKILLS.some((s) => existsSync(join(dir, s, "SKILL.md"))) ? dir : null;
}

const bundledPath = (name) => join(BUNDLED_DIR, name, "SKILL.md");
const manifestPath = (name) => join(BUNDLED_DIR, name, "UPSTREAM.json");

/** Every way a bundled copy is wrong. */
export function skillDrift(skillsDir = findSkillsDir()) {
  const drift = [];
  for (const name of SYNCED_SKILLS) {
    if (!existsSync(bundledPath(name))) { drift.push(`${name}/SKILL.md is missing`); continue; }
    const text = lf(readFileSync(bundledPath(name), "utf-8"));
    const manifest = existsSync(manifestPath(name)) ? JSON.parse(readFileSync(manifestPath(name), "utf-8")) : {};
    if (manifest.sha256 !== hashOf(text)) drift.push(`${name}/SKILL.md does not match the hash in its UPSTREAM.json (hand-edited?)`);
    const upstream = skillsDir && join(skillsDir, name, "SKILL.md");
    if (!upstream || !existsSync(upstream)) continue;
    try {
      if (adaptSkill(name, lf(readFileSync(upstream, "utf-8"))) !== text) drift.push(`${name}/SKILL.md differs from the adapted ${upstream}`);
    } catch (e) {
      drift.push(e.message);
    }
  }
  return drift;
}

export function syncSkills(skillsDir = findSkillsDir()) {
  if (!skillsDir) throw new Error("no skills found: set CLAUDE_SKILLS_DIR");
  for (const name of SYNCED_SKILLS) {
    const text = adaptSkill(name, lf(readFileSync(join(skillsDir, name, "SKILL.md"), "utf-8")));
    mkdirSync(join(BUNDLED_DIR, name), { recursive: true });
    writeFileSync(bundledPath(name), text);
    writeFileSync(manifestPath(name), JSON.stringify({ upstream: `~/.claude/skills/${name}/SKILL.md`, sha256: hashOf(text) }, null, 2) + "\n");
  }
  return SYNCED_SKILLS.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const skillsDir = findSkillsDir();
  if (process.argv.includes("--sync")) console.log(`check-skill-sync: adapted ${syncSkills(skillsDir)} skills from ${skillsDir}`);
  const drift = skillDrift(skillsDir);
  if (drift.length > 0) {
    console.error("bundled skills are out of sync (never hand-edit them; change the skill in ~/.claude/skills, then `node scripts/check-skill-sync.mjs --sync`):");
    for (const d of drift) console.error("  " + d);
    process.exit(1);
  }
  console.log(`check-skill-sync: OK (${SYNCED_SKILLS.length} skills${skillsDir ? "" : "; ~/.claude/skills not found, upstream comparison skipped"})`);
}
