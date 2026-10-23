/**
 * The AGENTS.md files that govern a path in a repo: every one from the repo's
 * root down to the directory holding `from`, root first, so a subtree's rules
 * read last and take precedence. Each is headed by its path relative to the
 * root.
 *
 * One reader for three callers that had two copies of this walk, both fixed
 * to LAX's own repo: a worker's context pack (ops/context-pack-builder.ts),
 * self_edit's prompt (self-edit/agents-rules.ts), and a code session's
 * prompt (context/project-agents-md.ts), whose root is the user's project.
 *
 * Not config/agent-rules.md: that is the product agent's own rules, injected
 * by agents-md-section.ts.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function collectAgentsMd(root: string, from?: string): string {
  try {
    const start = from ? (isAbsolute(from) ? from : resolve(root, from)) : root;
    let cur = existsSync(start) && !statSync(start).isDirectory() ? dirname(start) : existsSync(start) ? start : dirname(start);
    const dirs: string[] = [];
    while (true) {
      dirs.push(cur);
      if (cur === root || !cur.startsWith(root)) break;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    if (!dirs.includes(root)) dirs.push(root);
    const parts: string[] = [];
    for (const dir of dirs.reverse()) {
      const file = join(dir, "AGENTS.md");
      if (!existsSync(file)) continue;
      const rel = relative(root, file).replace(/\\/g, "/") || "AGENTS.md";
      parts.push(`--- ${rel} ---\n${readFileSync(file, "utf-8").trim()}`);
    }
    return parts.join("\n\n");
  } catch {
    // An unreadable file or a vanished directory means no rules to add, not a failed prompt.
    return "";
  }
}
