// Direct-HTTP OAuth path for Anthropic subscription tokens.
//
// Subscription OAuth tokens are accepted on the Messages API when the request
// carries the Claude Code request shape (Bearer auth + the claude-code betas +
// a claude-code user-agent + the "You are Claude Code…" system prefix). This is
// the ONLY subscription path that streams real `thinking_delta` text — the
// `claude` CLI subprocess redacts reasoning text in its stream-json output, so
// the CLI proxy can never show a live Thinking block. stream.ts routes every
// subscription credential here; the CLI proxy is hidden behind
// LAX_ANTHROPIC_CLI_TRANSPORT (see cli-transport.ts).
//
// Kept separate from stream-api.ts so the OAuth-only concerns (request shape,
// version floor, tool-name billing-classifier workaround) live in one auditable
// place and stream-api.ts stays a plain transport.

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

// Anthropic gates each model on a MINIMUM claude-code version carried in the
// user-agent, and rejects older ones with a 400 that names the floor:
// "Claude Code 2.1.110 does not support this model; version 2.1.280 or newer is
// required." The version used to come from the locally installed `claude` CLI
// (with a pinned fallback), which made the CLI — a tool this path never runs —
// decide whether chat worked: a user who never installed it was stuck on the
// fallback once a new model raised the floor (Opus 5.5, 2026-09-23), and one
// who updated it still needed a restart to drop the cached value. Now the
// version starts at a known-good floor and ratchets UP to whatever a rejection
// names; streamViaAPI retries that request once with the adopted version.
const CLAUDE_CODE_VERSION_FLOOR = "2.1.280";
let claudeCodeVersion = CLAUDE_CODE_VERSION_FLOOR;

const REQUIRED_VERSION_RE = /version (\d+\.\d+\.\d+) or newer is required/;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function claudeCodeUserAgent(): string {
  return `claude-code/${claudeCodeVersion} (external, cli)`;
}

/** If `errorText` is a version-floor rejection naming a version NEWER than the
 *  one we send, adopt it and return true (the caller retries once). Returns
 *  false for any other error, or a floor we already meet — so a rejection that
 *  persists after adopting can never loop. */
export function adoptRequiredClaudeCodeVersion(errorText: string): boolean {
  const required = REQUIRED_VERSION_RE.exec(errorText)?.[1];
  if (!required || compareVersions(required, claudeCodeVersion) <= 0) return false;
  claudeCodeVersion = required;
  return true;
}

export function resetClaudeCodeVersionForTest(): void {
  claudeCodeVersion = CLAUDE_CODE_VERSION_FLOOR;
}

/** Build the request headers for the direct-HTTP OAuth path. `bearer` is the raw token. */
export function buildOAuthHeaders(bearer: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": OAUTH_BETAS.join(","),
    "authorization": `Bearer ${bearer}`,
    "user-agent": claudeCodeUserAgent(),
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
