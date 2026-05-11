/**
 * Read protocol bodies from protocols/bundled/{name}/ at runtime and cache
 * them for the life of the process. Strips YAML frontmatter so what's left
 * is the methodology body that goes into a worker subprocess's prompt.
 *
 * Why inline the body instead of just emitting "/senior-engineer"?
 * The worker is `claude -p` (Claude Code), which loads skills from
 * `~/.claude/skills/` on the machine running the build. If the user
 * hasn't installed those skills personally, the slash command resolves
 * to nothing and the worker loses the discipline anchor. Inlining the
 * body makes the LAX repo self-contained — new installs work without
 * touching `~/.claude/skills/`. The cost is ~5 KB per worker prompt,
 * negligible against the cost of a worker run.
 *
 * Bundled bodies live at:
 *   protocols/bundled/senior-engineer/SKILL.md
 *   protocols/bundled/vibe-code/SKILL.md
 *   protocols/bundled/app-build/SKILL.md
 *
 * Same directory the Protocols browser scans (see src/protocols/loader.ts)
 * — one source of truth for SKILL.md content, two consumers.
 *
 * If the file is missing OR the frontmatter says `user-invocable: true`
 * but we need it as worker-only, we still return the body — the loader
 * doesn't second-guess the bundle. Loud failure path: file missing →
 * throw on first use so the operator notices instead of silently
 * shipping bare prompts.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is src/primal-auto-build/ (or dist/primal-auto-build/ after tsc).
// Both resolve to <repo>/protocols/bundled via two levels up.
const SKILLS_DIR = join(HERE, "..", "..", "protocols", "bundled");

const cache = new Map<string, string>();

/**
 * Load a skill body by name. Returns the markdown body with YAML
 * frontmatter stripped. Throws on first call if the skill bundle is
 * missing — failing loud is better than a worker that quietly lost its
 * discipline anchor.
 */
export function loadSkillBody(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const path = join(SKILLS_DIR, name, "SKILL.md");
  if (!existsSync(path)) {
    throw new Error(`protocol body missing at ${path} — expected protocols/bundled/${name}/SKILL.md to be present in the repo`);
  }

  const raw = readFileSync(path, "utf-8");
  const body = stripFrontmatter(raw).trim();
  cache.set(name, body);
  return body;
}

/** Test-only helper to bust the cache so reloads pick up edited bodies. */
export function _resetSkillBodyCache(): void {
  cache.clear();
}

/**
 * Remove a leading YAML frontmatter block (--- … ---). Returns the rest
 * of the file unchanged. If no frontmatter, returns the input as-is.
 */
function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/);
  if (!match) return raw;
  return raw.slice(match[0].length);
}
