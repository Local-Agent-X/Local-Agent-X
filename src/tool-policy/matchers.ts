import { checkRegexSafety } from "../safe-regex.js";

/** Match an argument value against a glob pattern.
 *  Supports: "git *" matches "git status", "workspace/*" matches "workspace/foo.txt",
 *  "*.ts" matches "index.ts", exact match for no wildcards. */
export function matchArgPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;
  // Convert glob to regex: * → .*, escape other regex chars
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try {
    if (checkRegexSafety(escaped) !== null) return false; // unsafe pattern — reject
    return new RegExp(`^${escaped}$`, "i").test(value);
  } catch { return false; }
}

/** Match a tool name against a glob pattern */
export function matchGlob(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern === name) return true;
  // Simple glob: "http_*" matches "http_request"
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  // "browser.*" matches "browser" (the tool is "browser", action is separate)
  if (pattern.includes(".*")) {
    return name === pattern.replace(".*", "");
  }
  return false;
}

/** Match a host against an allowlist (supports *.example.com) */
export function matchHost(patterns: string[], host: string): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const pl = p.toLowerCase();
    if (pl === h) return true;
    if (pl.startsWith("*.") && h.endsWith(pl.slice(1))) return true;
    return false;
  });
}
