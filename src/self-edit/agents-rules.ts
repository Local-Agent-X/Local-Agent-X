import { fileURLToPath } from "node:url";

export const LAX_REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Walk up from scopeHint looking for AGENTS.md files; return their concatenated
 * contents, root-first so subtree rules override. If no scope hint, just return
 * the root AGENTS.md. Subtree files take precedence visually (listed last).
 */
export async function collectSubtreeRules(scopeHint: string): Promise<string> {
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join, dirname, isAbsolute, resolve, relative } = await import("node:path");
    const resolved = scopeHint
      ? (isAbsolute(scopeHint) ? scopeHint : resolve(LAX_REPO_ROOT, scopeHint))
      : LAX_REPO_ROOT;
    const dirs: string[] = [];
    let cur = existsSync(resolved) ? resolved : dirname(resolved);
    try { const { statSync } = await import("node:fs"); if (existsSync(resolved) && !statSync(resolved).isDirectory()) cur = dirname(resolved); } catch {}
    while (true) {
      dirs.push(cur);
      if (cur === LAX_REPO_ROOT || !cur.startsWith(LAX_REPO_ROOT)) break;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    if (!dirs.includes(LAX_REPO_ROOT)) dirs.push(LAX_REPO_ROOT);
    const parts: string[] = [];
    for (const d of dirs.reverse()) {
      const p = join(d, "AGENTS.md");
      if (existsSync(p)) {
        const rel = relative(LAX_REPO_ROOT, p).replace(/\\/g, "/") || "AGENTS.md";
        const body = readFileSync(p, "utf-8").trim();
        parts.push(`--- ${rel} ---\n${body}`);
      }
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}
