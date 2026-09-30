/**
 * The projects a reviewed op worked in, read from the paths its tool calls
 * named. A playbook named after the repo it happened in
 * (`jobs_in_order_crm_master_push`) is derivable from that repo, and the
 * workspace listing alone cannot catch it when the repo lives anywhere else on
 * the machine. The op's own paths can: every directory directly under the home
 * dir, the workspace root, or `workspace/apps` that a call touched is a project
 * name the proposal may not carry.
 *
 * Message content is walked shape-agnostically (objects, arrays, strings, and
 * JSON-encoded strings), so a change to how tool calls are stored cannot
 * silently blind this.
 */
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { readOpMessages } from "../../canonical-loop/store.js";
import { workspaceRoot } from "../../config.js";

const PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\/)(?:[^\\/\s"'<>|`]+[\\/]?)+/g;
const MAX_STRINGS = 5000;
const MAX_NAMES = 24;

function normalizeSegment(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function* strings(value: unknown, budget: { left: number }): Generator<string> {
  if (budget.left <= 0) return;
  if (typeof value === "string") {
    budget.left--;
    yield value;
    const trimmed = value.trimStart();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 200_000) {
      try { yield* strings(JSON.parse(trimmed), budget); } catch { /* plain text */ }
    }
    return;
  }
  if (Array.isArray(value)) { for (const item of value) yield* strings(item, budget); return; }
  if (value && typeof value === "object") { for (const item of Object.values(value)) yield* strings(item, budget); }
}

/** Roots whose direct children are project directories. */
function projectRoots(): string[] {
  const workspace = resolve(workspaceRoot());
  return [resolve(homedir()), workspace, resolve(workspace, "apps")].map((root) => root.toLowerCase());
}

/** The first path segment under any project root, for every path in `text`. */
export function projectNamesInText(text: string, roots: readonly string[] = projectRoots()): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PATH_PATTERN)) {
    // Git Bash spells C:\Users as /c/Users; the shell tool's commands use it.
    const spelled = match[0].replace(/^\/([a-zA-Z])\//, "$1:/");
    const path = resolve(spelled).toLowerCase();
    for (const root of roots) {
      if (!path.startsWith(root + sep)) continue;
      const child = path.slice(root.length + 1).split(sep)[0];
      const name = normalizeSegment(child);
      if (name.length >= 3 && name !== "apps") names.add(name);
    }
  }
  return [...names];
}

export function projectNamesTouchedBy(opId: string): string[] {
  const roots = projectRoots();
  const names = new Set<string>();
  const budget = { left: MAX_STRINGS };
  for (const row of readOpMessages(opId)) {
    for (const text of strings(row.content, budget)) {
      for (const name of projectNamesInText(text, roots)) names.add(name);
      if (names.size >= MAX_NAMES) return [...names];
    }
  }
  return [...names];
}
