#!/usr/bin/env node
/**
 * Bundled-skill gate for the skills Local Agent X ships from the owner's own
 * Claude Code skills (~/.claude/skills): senior-engineer, canonical-check,
 * blast-radius and new-project under src/protocols/bundled/. The skill is the
 * source of truth; the bundled copy is that text with its Claude Code tool
 * names swapped for LAX's (ADAPTATIONS), so it is never hand-edited.
 *
 * A skill's references/*.md travel with it, byte for byte: the protocol loader
 * serves whatever sits beside a bundled SKILL.md (src/protocols/skill-files.ts).
 * Its scripts/ and assets/ do not: new-project's are the structure kit, vendored
 * once at src/app-scaffold/kit/ by scripts/check-kit-sync.mjs.
 *
 * The copy drifts two ways, and this catches both:
 *   1. Hand edits here. UPSTREAM.json beside each SKILL.md records the sha256 of
 *      the bundled text (line endings folded to LF), and of each companion file
 *      under `files`. A changed hash fails.
 *   2. The skill moving on. When it is found ($CLAUDE_SKILLS_DIR, else
 *      ~/.claude/skills), the bundled text must equal the adapted skill, and
 *      each companion file its upstream.
 *      Without it (CI, an install, another machine) this half is skipped, loudly.
 * Every adaptation must still match the skill's wording: a reworded line fails
 * here instead of shipping Claude Code's tool names to LAX's agent.
 *
 *   --sync   adapt every skill into the bundle and record the hashes. The only
 *            way these SKILL.md files should change.
 * Runs in `npm run build` (check:skill-sync).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const BUNDLED_DIR = join(repoRoot, "src", "protocols", "bundled");
export const SYNCED_SKILLS = ["senior-engineer", "canonical-check", "blast-radius", "new-project"];

/** Claude Code tool → LAX tool, for the frontmatter's allowed-tools list. LAX has
 *  no PowerShell tool: its `bash` is the one shell, so a skill allowing both
 *  shells lists `bash` once (adaptSkill drops the duplicate). */
export const TOOL_NAMES = {
  Read: "read", Write: "write", Edit: "edit", Glob: "glob", Grep: "grep", Bash: "bash", PowerShell: "bash",
  Agent: "agent_spawn", AskUserQuestion: "ask_user",
};

// What a project built here gets instead of copying the skill's scripts by hand:
// the project_kit tool writes the kit (src/app-scaffold/) into the session's
// project folder. The refs hint hook is a Claude Code hook the kit does not ship.
const KIT_INTRO = "The project must own its checks, so they live in the project. Call\n`project_kit` once: it writes these into the project folder, never overwriting\na file that exists, along with the AGENTS.md, ARCHITECTURE.md, ADR 0001 and\n`docs/history/README.md` of step 4, and wires the npm scripts of step 3 when a\n`package.json` is present:";
const HOOK_OFFER = "For a TS/JS project, offer the refs hint hook. Agents reach for grep out of\nhabit, and a grep for `hasCapability` misses `import { hasCapability as can }`\nand matches every comment. The hook adds one line of context after such a\nsearch, pointing at `refs`. It never blocks, says each name once per session,\nand is silent in a repo with no `refs` script. It goes in the project's\n`.claude/settings.json` when that file is committed, otherwise in the user's\nown settings (a user-level entry stays silent in other repos):\n\n```json\n\"hooks\": { \"PostToolUse\": [{ \"matcher\": \"Grep|Bash\",\n  \"hooks\": [{ \"type\": \"command\", \"command\": \"node scripts/refs-hint-hook.mjs\" }] }] }\n```\n\nAt user level, give the command the hook's absolute path. `REFS_HINT=0` turns\nit off for one shell.";
const HOOK_NOT_SHIPPED = "The refs hint hook is not shipped here, so there is none to offer. Agents\nreach for grep out of habit, and a grep for `hasCapability` misses\n`import { hasCapability as can }` and matches every comment; put that reason,\nand `npm run refs -- <Name>`, in the project's AGENTS.md instead.";

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
  "new-project": [
    // Siblings LAX does not bundle (src/protocols/bundled/ has app-build and brownfield).
    ["Also use before /app-build or /grand-daddy-green scaffolding", "Also use before /app-build scaffolding"],
    [" (and the tests to run), an optional hook that steers grep toward those references, module seal", " (and the tests to run), module seal"],
    ["- `/brownfield`, `/grand-daddy-brown`: carry out", "- `/brownfield`: carry out"],
    ["- `/app-build`, `/grand-daddy-green`: build a new app", "- `/app-build`: build a new app"],
    // Step 2: the kit is written by a tool, not copied from ~/.claude/skills.
    ["The project must own its checks. CI and other machines can't reach\n`~/.claude/skills`. Copy these into `scripts/`:", KIT_INTRO],
    ["| From this skill | Purpose |", "| What `project_kit` writes | Purpose |"],
    ["| `scripts/refs-hint-hook.mjs` | TS/JS only, optional: a Claude Code hook that suggests `npm run refs -- <Name>` when an agent greps for a code symbol (step 3) |", "| `scripts/refs-hint-hook.mjs` | not shipped here: a hook for another harness, and the kit installs no hooks |"],
    ["Put the seal test where the test runner finds it.", "`project_kit` puts the seal test where the test runner finds it."],
    // Step 3 and its probe in step 6: the hook it offers is not shipped.
    [HOOK_OFFER, HOOK_NOT_SHIPPED],
    ["- With the hook on: grep for a camelCase name → the reply carries the `refs`\n  hint once, and a second grep for it doesn't.", "- No hook probe: the refs hint hook is not shipped here."],
  ],
};

const lf = (text) => text.replace(/\r\n/g, "\n");
const hashOf = (text) => createHash("sha256").update(text).digest("hex");

/** The frontmatter with LAX's tool names, one line per LAX tool. */
function adaptFrontmatter(name, front) {
  const seen = new Set();
  return front.split("\n").flatMap((line) => {
    const m = /^(\s+- )(\S+)$/.exec(line);
    if (!m) return [line];
    const [, lead, tool] = m;
    if (!(tool in TOOL_NAMES)) throw new Error(`${name}: allowed-tools names ${tool}, which TOOL_NAMES does not map to a LAX tool`);
    if (seen.has(TOOL_NAMES[tool])) return [];
    seen.add(TOOL_NAMES[tool]);
    return [lead + TOOL_NAMES[tool]];
  }).join("\n");
}

/** The skill's text as LAX ships it. Throws on a tool or phrase it cannot map. */
export function adaptSkill(name, text) {
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---") || end < 0) throw new Error(`${name}: no frontmatter`);
  // The phrases are swapped in the frontmatter too: a description names siblings.
  let out = adaptFrontmatter(name, text.slice(0, end)) + text.slice(end);
  for (const [from, to] of ADAPTATIONS[name] ?? []) {
    if (!out.includes(from)) throw new Error(`${name}: the skill no longer says "${from}"; update ADAPTATIONS in scripts/check-skill-sync.mjs`);
    out = out.split(from).join(to);
  }
  return out;
}

/** Where the owner's skills are, or null when this machine has none. */
export function findSkillsDir() {
  const dir = process.env.CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
  return SYNCED_SKILLS.some((s) => existsSync(join(dir, s, "SKILL.md"))) ? dir : null;
}

const bundledPath = (dir, name) => join(dir, name, "SKILL.md");
const manifestPath = (dir, name) => join(dir, name, "UPSTREAM.json");
const readManifest = (dir, name) => (existsSync(manifestPath(dir, name)) ? JSON.parse(readFileSync(manifestPath(dir, name), "utf-8")) : {});

/** The companion files a skill ships beside SKILL.md: its references/*.md,
 *  as skill-relative forward-slashed paths. Never its scripts/ or assets/. */
export function companionFiles(skillDir) {
  const refs = join(skillDir, "references");
  if (!existsSync(refs)) return [];
  return readdirSync(refs).filter((f) => f.endsWith(".md")).sort().map((f) => `references/${f}`);
}

/** Every way a bundled copy's companion files are wrong. */
function companionDrift(bundledDir, name, manifest, skillDir) {
  const drift = [];
  const recorded = manifest.files ?? {};
  for (const [file, sha256] of Object.entries(recorded)) {
    const path = join(bundledDir, name, file);
    if (!existsSync(path)) { drift.push(`${name}/${file} is missing`); continue; }
    const text = lf(readFileSync(path, "utf-8"));
    if (sha256 !== hashOf(text)) drift.push(`${name}/${file} does not match the hash in its UPSTREAM.json (hand-edited?)`);
    const upstream = skillDir && join(skillDir, file);
    if (!upstream) continue;
    if (!existsSync(upstream)) drift.push(`${name}/${file} is bundled but no longer in ${skillDir}`);
    else if (lf(readFileSync(upstream, "utf-8")) !== text) drift.push(`${name}/${file} differs from ${upstream}`);
  }
  if (skillDir) {
    for (const file of companionFiles(skillDir)) {
      if (!(file in recorded)) drift.push(`${name}/${file} is not bundled (${skillDir} has it)`);
    }
  }
  return drift;
}

/** Every way a bundled copy is wrong. The last two parameters are for tests
 *  that sync a scratch skill into a scratch bundle. */
export function skillDrift(skillsDir = findSkillsDir(), bundledDir = BUNDLED_DIR, names = SYNCED_SKILLS) {
  const drift = [];
  for (const name of names) {
    if (!existsSync(bundledPath(bundledDir, name))) { drift.push(`${name}/SKILL.md is missing`); continue; }
    const text = lf(readFileSync(bundledPath(bundledDir, name), "utf-8"));
    const manifest = readManifest(bundledDir, name);
    if (manifest.sha256 !== hashOf(text)) drift.push(`${name}/SKILL.md does not match the hash in its UPSTREAM.json (hand-edited?)`);
    const skillDir = skillsDir && existsSync(join(skillsDir, name, "SKILL.md")) ? join(skillsDir, name) : null;
    drift.push(...companionDrift(bundledDir, name, manifest, skillDir));
    if (!skillDir) continue;
    try {
      if (adaptSkill(name, lf(readFileSync(join(skillDir, "SKILL.md"), "utf-8"))) !== text) drift.push(`${name}/SKILL.md differs from the adapted ${join(skillDir, "SKILL.md")}`);
    } catch (e) {
      drift.push(e.message);
    }
  }
  return drift;
}

export function syncSkills(skillsDir = findSkillsDir(), bundledDir = BUNDLED_DIR, names = SYNCED_SKILLS) {
  if (!skillsDir) throw new Error("no skills found: set CLAUDE_SKILLS_DIR");
  for (const name of names) {
    const skillDir = join(skillsDir, name);
    const text = adaptSkill(name, lf(readFileSync(join(skillDir, "SKILL.md"), "utf-8")));
    mkdirSync(join(bundledDir, name), { recursive: true });
    writeFileSync(bundledPath(bundledDir, name), text);
    const manifest = { upstream: `~/.claude/skills/${name}/SKILL.md`, sha256: hashOf(text) };
    const files = companionFiles(skillDir);
    if (files.length > 0) manifest.files = {};
    for (const file of files) {
      const companion = lf(readFileSync(join(skillDir, file), "utf-8"));
      mkdirSync(dirname(join(bundledDir, name, file)), { recursive: true });
      writeFileSync(join(bundledDir, name, file), companion);
      manifest.files[file] = hashOf(companion);
    }
    writeFileSync(manifestPath(bundledDir, name), JSON.stringify(manifest, null, 2) + "\n");
  }
  return names.length;
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
