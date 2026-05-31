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

import { homedir } from "node:os";
import { join } from "node:path";
import { isCredentialKey } from "../mcp-client/connection.js";
import { ENV_ALLOWLIST } from "../mcp-client/env-credential-patterns.js";
import { getNpmGlobalBin } from "../anthropic-client/cli-path.js";

/**
 * The ONLY credential keys each surgeon CLI may inherit — its own provider
 * auth. Everything else is stripped. Exempted from the final credential strip.
 * Uppercase-canonical to match isCredentialKey's comparison. Each CLI ALSO
 * reads its own on-disk store (~/.claude, ~/.codex/auth.json, ~/.grok/auth.json)
 * via HOME — which the allowlist passes through — so subscription logins need
 * none of these; the env vars cover API-key-only installs.
 */
const AUTH_PASSTHROUGH_BY_PROVIDER: Record<string, ReadonlySet<string>> = {
  anthropic: new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]),
  codex: new Set(["OPENAI_API_KEY", "CODEX_API_KEY"]),
  xai: new Set(["XAI_API_KEY", "GROK_API_KEY", "GROK_DEPLOYMENT_KEY"]),
};

/** Back-compat: the default (anthropic) passthrough set. */
export const CHILD_AUTH_PASSTHROUGH = AUTH_PASSTHROUGH_BY_PROVIDER.anthropic;

/**
 * Build the scrubbed env for a self_edit surgeon subprocess.
 *
 * @param base source env to scrub (defaults to process.env; injectable for tests)
 * @param provider which surgeon CLI — selects the auth passthrough set and any
 *        provider-specific PATH fixup (defaults to "anthropic")
 */
export function buildSelfEditChildEnv(base: NodeJS.ProcessEnv = process.env, provider: string = "anthropic"): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  const passthrough = AUTH_PASSTHROUGH_BY_PROVIDER[provider] ?? AUTH_PASSTHROUGH_BY_PROVIDER.anthropic;

  // 1. Allowlist passthrough — non-credential vars the child needs to run.
  for (const key of ENV_ALLOWLIST) {
    const val = base[key];
    if (typeof val === "string" && val.length > 0) out[key] = val;
  }

  // 2. The child's own provider auth — pass through if present so API-key-only
  //    installs (no CLI login) still authenticate.
  for (const key of passthrough) {
    const val = base[key];
    if (typeof val === "string" && val.length > 0) out[key] = val;
  }

  // 3. Final credential strip (defense-in-depth) — runs the shared deny
  //    tables over everything assembled above, exempting the child's own
  //    provider auth. A no-op for the current allowlist, but guards against
  //    a credential-shaped var sneaking in if the allowlist ever grows.
  for (const key of Object.keys(out)) {
    if (isCredentialKey(key, passthrough)) delete out[key];
  }

  // 4. Prepend the npm global bin so a globally-installed `claude`/`codex`
  //    (and `.cmd` on Windows) resolves on PATH — same fixup
  //    npmAugmentedEnv() applies, but on top of the scrubbed PATH.
  const sep = process.platform === "win32" ? ";" : ":";
  const bin = getNpmGlobalBin();
  if (bin) out.PATH = `${bin}${sep}${out.PATH || ""}`;

  // 5. The grok binary lives in ~/.grok/bin (not an npm global), so the xAI
  //    surgeon needs it on PATH to resolve.
  if (provider === "xai") out.PATH = `${join(homedir(), ".grok", "bin")}${sep}${out.PATH || ""}`;

  return out;
}
