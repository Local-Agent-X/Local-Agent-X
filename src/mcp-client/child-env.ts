// The env an MCP child subprocess is spawned with. Split from connection.ts
// (400-LOC cap); the credential tables live in env-credential-patterns.ts.
import { createLogger } from "../logger.js";
import { DENY_PREFIXES, DENY_SUBSTRINGS, DENY_EXACT, ENV_ALLOWLIST } from "./env-credential-patterns.js";

const logger = createLogger("mcp-client");

// ─────────────────────────────────────────────────────────────────────
// MCP child env construction
//
// Default-deny. The previous spawn-env merge handed every host env var
// (ANTHROPIC_API_KEY, AWS creds, GitHub tokens, …) to every MCP
// subprocess. Replaced with a curated allowlist of vars MCP
// children legitimately need for binary resolution / locale / temp dirs,
// plus explicit per-server grants. A deny-pattern filter runs AFTER the
// merge so a caller cannot grant a credential via configEnv either —
// credentials must flow through the secret vault, never env injection.
// ─────────────────────────────────────────────────────────────────────

// ENV_ALLOWLIST moved to ./env-credential-patterns.js so the self_edit child
// env builder can share the same allowlist (one source of truth).

/**
 * Match `key` against the shared credential-deny tables.
 *
 * `exemptCredentialKeys` lets a trusted-code caller (warm-pool bridge env
 * builder in src/anthropic-client/mcp-config.ts) bypass the deny for
 * specific keys it legitimately needs to pass through — currently
 * `LAX_MCP_TOKEN`, which the bridge needs to authenticate back to LAX but
 * which the external-MCP path must still strip. Pass keys in their
 * canonical (uppercase) form; the comparison is case-insensitive.
 */
export function isCredentialKey(key: string, exemptCredentialKeys?: ReadonlySet<string>): boolean {
  const upper = key.toUpperCase();
  if (exemptCredentialKeys && exemptCredentialKeys.has(upper)) return false;
  if (DENY_EXACT.includes(upper)) return true;
  for (const prefix of DENY_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const sub of DENY_SUBSTRINGS) {
    if (upper.includes(sub)) return true;
  }
  return false;
}

let allowlistLogged = false;

/**
 * Build the env for an MCP child subprocess. Default-deny: only the
 * curated allowlist passes through from process.env, then per-server
 * grants from `configEnv`, then a final credential-pattern strip.
 *
 * `exemptCredentialKeys` (uppercase canonical names) are env keys the strip
 * leaves alone — these are the per-server keys whose value came from a vault
 * `${secret:...}` placeholder (the legitimate, documented injection channel,
 * e.g. GITHUB_PERSONAL_ACCESS_TOKEN=${secret:GITHUB_TOKEN}). A host process.env
 * credential never reaches the exemption (the allowlist excludes it), and a
 * RAW inlined token (no ${secret:}) is not exempt — so it's still stripped,
 * preserving the "use the vault, don't inline" guarantee for the synced config.
 */
export function buildMcpChildEnv(
  configEnv?: Record<string, string>,
  exemptCredentialKeys?: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};

  // Allowlist passthrough
  const granted: string[] = [];
  for (const key of ENV_ALLOWLIST) {
    const val = process.env[key];
    if (typeof val === "string" && val.length > 0) {
      out[key] = val;
      granted.push(key);
    }
  }

  if (!allowlistLogged) {
    logger.info(`mcp-env: allowlist active (${granted.length} vars passed: ${granted.join(", ") || "<none>"})`);
    allowlistLogged = true;
  }

  // Per-server grants (caller-controlled, overrides allowlist values)
  if (configEnv) {
    for (const [k, v] of Object.entries(configEnv)) {
      if (typeof v === "string") out[k] = v;
    }
  }

  // Final credential strip — runs after merge so caller grants can't
  // smuggle a credential through either.
  const stripped: string[] = [];
  for (const key of Object.keys(out)) {
    if (isCredentialKey(key, exemptCredentialKeys)) {
      delete out[key];
      stripped.push(key);
    }
  }
  if (stripped.length > 0) {
    logger.warn(`mcp-env: stripped credential-pattern keys (use secret vault instead): ${stripped.join(", ")}`);
  }

  return out;
}

// Test-only reset for the once-per-process info log. Not exported via
// the public API; consumed by env-builder tests to assert clean state
// across test cases.
export function __resetMcpEnvLogState(): void {
  allowlistLogged = false;
}
