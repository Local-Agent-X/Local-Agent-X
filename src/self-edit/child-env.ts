/**
 * Confidentiality scrub for the self_edit `claude -p` subprocess env.
 *
 * The self_edit child runs `claude -p --permission-mode bypassPermissions`
 * with full repo read + bash. A prompt-injected child (injection via the
 * task text OR via repo/workspace content it reads) can read whatever it's
 * handed and bash it out to the network. The cheapest, highest-value
 * exfil path is the ENVIRONMENT: the previous spawn sites passed
 * `npmAugmentedEnv()` = `{ ...process.env }`, handing every credential in
 * the LAX server's env (GitHub/AWS/Stripe/Twilio tokens, the LAX auth
 * token, third-party API keys, …) straight to the child. One `curl` and
 * they're gone.
 *
 * This builds a default-deny env instead — the same stance the MCP child
 * spawner already takes (see buildMcpChildEnv in mcp-client/connection.ts).
 * Only the binary-resolution / shell / locale / temp / home allowlist
 * passes through, plus the ONE credential class the child legitimately
 * needs: its own Anthropic auth. A `claude -p` subprocess *is* Claude Code;
 * it must reach the Anthropic API. Passing the Anthropic auth var through
 * (when present — API-key installs) keeps the child working out-of-the-box
 * while every OTHER credential is stripped.
 *
 * Residual (documented in docs/self-edit-hardening.md): the Anthropic
 * credential the child holds — whether via this passthrough or its own
 * ~/.claude OAuth store — remains readable and exfiltratable by an injected
 * child. That is irreducible without an OS-level egress jail (not feasible
 * out-of-the-box on Windows). This scrub removes the easy bulk-credential
 * env path; it does not make the child hermetic.
 */

import { isCredentialKey } from "../mcp-client/connection.js";
import { ENV_ALLOWLIST } from "../mcp-client/env-credential-patterns.js";
import { getNpmGlobalBin } from "../anthropic-client/cli-path.js";

/**
 * The credential keys the child is allowed to inherit — its own Anthropic
 * auth. Exempted from the final credential strip. Uppercase-canonical to
 * match isCredentialKey's comparison. CLAUDE_CODE_OAUTH_TOKEN covers the
 * OAuth-token install shape; the common Claude-CLI subscription login reads
 * ~/.claude from disk and needs none of these.
 */
export const CHILD_AUTH_PASSTHROUGH: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/**
 * Build the scrubbed env for a self_edit `claude -p` subprocess.
 *
 * @param base source env to scrub (defaults to process.env; injectable for tests)
 */
export function buildSelfEditChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};

  // 1. Allowlist passthrough — non-credential vars the child needs to run.
  for (const key of ENV_ALLOWLIST) {
    const val = base[key];
    if (typeof val === "string" && val.length > 0) out[key] = val;
  }

  // 2. The child's own Anthropic auth — pass through if present so
  //    API-key-only installs (no `claude login`) still authenticate.
  for (const key of CHILD_AUTH_PASSTHROUGH) {
    const val = base[key];
    if (typeof val === "string" && val.length > 0) out[key] = val;
  }

  // 3. Final credential strip (defense-in-depth) — runs the shared deny
  //    tables over everything assembled above, exempting the child's own
  //    Anthropic auth. A no-op for the current allowlist, but guards against
  //    a credential-shaped var sneaking in if the allowlist ever grows.
  for (const key of Object.keys(out)) {
    if (isCredentialKey(key, CHILD_AUTH_PASSTHROUGH)) delete out[key];
  }

  // 4. Prepend the npm global bin so a globally-installed `claude`
  //    (claude.cmd on Windows) resolves on PATH — same fixup
  //    npmAugmentedEnv() applies, but on top of the scrubbed PATH.
  const bin = getNpmGlobalBin();
  if (bin) {
    const sep = process.platform === "win32" ? ";" : ":";
    out.PATH = `${bin}${sep}${out.PATH || ""}`;
  }

  return out;
}
