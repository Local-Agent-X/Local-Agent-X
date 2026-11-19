import { checkRegexSafety } from "../safe-regex.js";
import { createLogger } from "../logger.js";
import { matchEgressList } from "../security/layer/host-list.js";

const logger = createLogger("tool-policy/matchers");

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
  } catch (e) {
    // Returning false here silently fails a policy match, which can flip
    // an allow-rule to deny (or vice versa) without any operator signal.
    // Log so corrupted rules surface in server.log instead of producing
    // confusing "tool blocked for no apparent reason" failures.
    logger.warn(`pattern compile failed for "${pattern}": ${(e as Error).message}`);
    return false;
  }
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

/** Match a host against a rule's allowedHosts / blockedHosts, through the one
 *  host-list matcher (security/layer/host-list.ts). A block list honours a
 *  broad wildcard (`*.ru`); an allow list ignores one, as the egress allowlist does. */
export function matchHost(patterns: string[], host: string, list: "allow" | "block"): boolean {
  return matchEgressList(host, new Set(patterns.map((p) => p.toLowerCase())), { broadWildcards: list === "block" });
}
