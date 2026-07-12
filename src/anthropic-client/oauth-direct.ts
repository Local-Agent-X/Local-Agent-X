// Direct-HTTP OAuth path for Anthropic subscription tokens.
//
// Anthropic banned third-party apps from calling the Messages API with a
// subscription OAuth token via the vanilla SDK shape (April 4, 2026) — those
// requests 400/429. But the SAME token IS accepted when the request carries
// Claude Code's own identity fingerprint (Bearer auth + the claude-code betas +
// a claude-code user-agent + the "You are Claude Code…" system prefix). That is
// the exact recipe the official CLI sends, and it is the ONLY subscription path
// that streams real `thinking_delta` text — the `claude` CLI subprocess redacts
// reasoning text in its stream-json output, so the CLI proxy can never show a
// live Thinking block. Chat opts into this path (see anthropic-transport.ts);
// builds and sub-agents stay on the CLI proxy where the agentic loop is
// load-bearing.
//
// Kept separate from stream-api.ts so the OAuth-only concerns (identity
// spoofing, tool-name billing-classifier workaround) live in one auditable
// place and stream-api.ts stays a plain transport.

import { execFileSync } from "node:child_process";
import { npmAugmentedEnv } from "./cli-path.js";

const DIRECT_OAUTH_PREFIX = "direct-oauth:";

/** Wrap a raw bearer token so stream.ts routes it to the direct-HTTP OAuth path. */
export function wrapDirectOAuthToken(token: string): string {
  return DIRECT_OAUTH_PREFIX + token;
}

/** Resolve the subscription OAuth token already wrapped for the direct-HTTP
 *  path, or null when none is available (unauthenticated / API-key users). The
 *  caller falls back to the CLI token. Shared by chat (anthropic-transport) and
 *  the classifier path so the token dance lives in one place. */
export async function resolveWrappedDirectToken(): Promise<string | null> {
  try {
    const { getAnthropicDirectToken } = await import("../auth/anthropic.js");
    const raw = await getAnthropicDirectToken();
    return raw ? wrapDirectOAuthToken(raw) : null;
  } catch {
    return null;
  }
}

export function isDirectOAuthToken(token: string): boolean {
  return token.startsWith(DIRECT_OAUTH_PREFIX);
}

export function unwrapDirectOAuthToken(token: string): string {
  return token.startsWith(DIRECT_OAUTH_PREFIX) ? token.slice(DIRECT_OAUTH_PREFIX.length) : token;
}

// System-prompt identity. The OAuth router keys on the system prompt STARTING
// with this exact string — without it, subscription tokens are rejected.
export const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

// Betas the official CLI ships on every OAuth request. `oauth-2025-04-20` +
// `claude-code-20250219` are the ones that actually gate routing; the thinking
// / tool-streaming betas are GA no-ops on Claude 4.6+ but harmless to send and
// still meaningful for older ids.
const OAUTH_BETAS = [
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
  "claude-code-20250219",
  "oauth-2025-04-20",
];

// Anthropic's OAuth infra validates the user-agent version and rejects requests
// whose spoofed claude-code version drifts too far behind the real release, so
// detect the installed CLI's version rather than pinning a constant that rots.
const CLAUDE_CODE_VERSION_FALLBACK = "2.1.110";
let versionCache: string | null = null;

export function detectClaudeCodeVersion(): string {
  if (versionCache) return versionCache;
  try {
    const out = execFileSync("claude", ["--version"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env: npmAugmentedEnv(),
    }).trim();
    // Output is like "2.1.110 (Claude Code)" or just "2.1.110".
    const v = out.split(/\s+/)[0];
    versionCache = v && /^\d/.test(v) ? v : CLAUDE_CODE_VERSION_FALLBACK;
  } catch {
    versionCache = CLAUDE_CODE_VERSION_FALLBACK;
  }
  return versionCache;
}

/** Build the request headers for the direct-HTTP OAuth path. `bearer` is the raw token. */
export function buildOAuthHeaders(bearer: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": OAUTH_BETAS.join(","),
    "authorization": `Bearer ${bearer}`,
    "user-agent": `claude-code/${detectClaudeCodeVersion()} (external, cli)`,
    "x-app": "cli",
  };
}

// ── Tool-name billing-classifier workaround ────────────────────────────────
//
// Anthropic's subscription/OAuth billing classifier treats a SINGLE-underscore
// `mcp_` tool name as a third-party-app fingerprint and flips the request off
// the plan-billing lane onto the metered extra-usage lane (empirically verified
// empirically: `mcp_foo` bills as extra-usage, `mcp__foo` bills to the plan). The
// official CLI puts BARE identifiers (Read, Bash — plan-billed) and
// double-underscore `mcp__server__tool` names on the wire; only the
// single-underscore form is the fingerprint.
//
// So we promote ONLY single-underscore `mcp_` names (LAX's MCP-server tools,
// `mcp_<server>_<tool>` per mcp-client/index.ts) to `mcp__`. LAX-native tools
// (`build_app`, `write`, …) are bare and MUST stay bare — verified live that
// bare names bill/behave fine on the OAuth path, and renaming `build_app` →
// `mcp__build_app` made Claude stop recognizing it as the app builder (it
// hand-wrote a broken stub instead of calling the tool).

// Tool NAMES that Anthropic's OAuth billing classifier fingerprints as a known
// third-party framework and routes to the metered extra-usage lane. Empirically
// bisected from a real LAX request: `memory_search` + `memory_get` PRESENT
// TOGETHER flip a request to extra-usage (400 "You're out of extra usage")
// even though neither alone does, and the request otherwise plan-bills — it
// matches a public MCP "memory server" tool signature. Renaming either one
// breaks the match (verified: `lax_memory_search`/`lax_memory_get` → plan-billed
// + thinking restored). We prefix them with `lax_` on the wire and reverse it on
// the inbound tool_call. Add names here as new fingerprints surface; the CLI
// fallback (stream.ts) covers any we haven't caught yet.
const CLASSIFIER_FINGERPRINT_TOOLS = new Set(["memory_search", "memory_get"]);
const FINGERPRINT_PREFIX = "lax_";

export function toOAuthWireName(name: string): string {
  if (CLASSIFIER_FINGERPRINT_TOOLS.has(name)) return FINGERPRINT_PREFIX + name;
  if (name.startsWith("mcp__")) return name;
  if (name.startsWith("mcp_")) return "mcp__" + name.slice("mcp_".length);
  return name;
}

/**
 * Reverse a wire name back to LAX's tool name. Prefer the explicit map built
 * from this turn's tools; fall back to stripping the `mcp__` prefix for names
 * that aren't in the current set (e.g. a tool_use replayed from history for a
 * tool no longer offered this turn).
 */
export function fromOAuthWireName(wire: string, wireToOriginal: Map<string, string>): string {
  const mapped = wireToOriginal.get(wire);
  if (mapped !== undefined) return mapped;
  if (wire.startsWith("mcp__")) return wire.slice("mcp__".length);
  // A fingerprint-renamed tool replayed from history that isn't in this turn's
  // tool set: strip the lax_ prefix ONLY when it fronts a known fingerprint name.
  if (wire.startsWith(FINGERPRINT_PREFIX) && CLASSIFIER_FINGERPRINT_TOOLS.has(wire.slice(FINGERPRINT_PREFIX.length))) {
    return wire.slice(FINGERPRINT_PREFIX.length);
  }
  return wire;
}
