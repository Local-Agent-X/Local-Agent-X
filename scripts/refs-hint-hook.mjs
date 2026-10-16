#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook (Grep, Bash): when an agent text-searches for
 * a name that looks like a code symbol (camelCase, PascalCase, SCREAMING_CASE),
 * add one line pointing at the repo's own `npm run refs -- <Name>`, which
 * answers "who uses this" with the compiler: renamed imports and re-exports
 * count, comments and strings don't. A suggestion only: it never blocks, never
 * changes the search, says nothing in a repo with no `refs` script, and says
 * it once per name per session. Any failure is silent.
 *
 * Enable it in Claude Code settings (user or project):
 *   "hooks": { "PostToolUse": [{ "matcher": "Grep|Bash",
 *     "hooks": [{ "type": "command", "command": "node <path>/refs-hint-hook.mjs" }] }] }
 * Turn it off for a shell with REFS_HINT=0.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The identifier a search pattern looks for, when it is one name and nothing else. */
export function searchedName(pattern) {
  if (typeof pattern !== "string") return null;
  const bare = pattern.trim()
    .replace(/^\\b|\\b$/g, "")
    .replace(/(\\s\*)?\\\($/, "")
    .replace(/\\b$/, "");
  return /^[A-Za-z_$][\w$]*$/.test(bare) ? bare : null;
}

/** Does a name look like a code symbol rather than a word? */
export function looksLikeSymbol(name) {
  if (!name || name.length < 4) return false;
  return /[a-z][A-Z]/.test(name) || /^[A-Z][a-z0-9]+[A-Z]/.test(name) || /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name);
}

/** The pattern a grep/rg command line searches for: its first non-flag argument. */
export function bashSearchPattern(command) {
  if (typeof command !== "string") return null;
  const m = /(?:^|[;&|]\s*)(?:rg|grep|git\s+grep)\s+(.+)/.exec(command);
  if (!m) return null;
  const tokens = m[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-e" || t === "--regexp") return tokens[i + 1]?.replace(/^["']|["']$/g, "") ?? null;
    if (t.startsWith("-")) continue;
    return t.replace(/^["']|["']$/g, "");
  }
  return null;
}

/** The nearest directory at or above `dir` whose package.json has a `refs` script. */
export function refsRepo(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const pkg = join(d, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).scripts?.refs) return d;
      } catch { /* unreadable package.json: keep looking up */ }
    }
    if (dirname(d) === d) return null;
  }
}

/** The hint for one hook event, or null when there is nothing to say. */
export function hintFor(event) {
  const input = event?.tool_input ?? {};
  const pattern = event?.tool_name === "Grep" ? input.pattern : event?.tool_name === "Bash" ? bashSearchPattern(input.command) : null;
  const name = searchedName(pattern);
  if (!looksLikeSymbol(name) || !refsRepo(event.cwd ?? process.cwd())) return null;
  return `\`${name}\` looks like a code symbol. For who uses it, \`npm run refs -- ${name}\` asks the compiler: ` +
    `renamed imports and re-exports count, comments and strings don't. Add \`--depth N\` for what those callers ` +
    `reach and the tests to run.`;
}

function alreadySaid(sessionId, name) {
  const file = join(tmpdir(), `refs-hint-${String(sessionId ?? "none").replace(/[^\w-]/g, "")}.json`);
  let said = [];
  try { said = JSON.parse(readFileSync(file, "utf8")); } catch { /* first hint this session */ }
  if (said.includes(name)) return true;
  writeFileSync(file, JSON.stringify([...said, name]));
  return false;
}

async function main() {
  if (process.env.REFS_HINT === "0") return;
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  const hint = hintFor(event);
  if (!hint || alreadySaid(event.session_id, hint.slice(1, hint.indexOf("`", 1)))) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hint } }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { /* a hint is never worth a failed tool call */ }).finally(() => process.exit(0));
}
