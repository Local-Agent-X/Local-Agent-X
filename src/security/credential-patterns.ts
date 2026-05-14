// ── Credential pattern catalog ──
// Single source of truth for "what counts as a credential" across the codebase.
// Two consumers today:
//   1. hooks/hook-engine.ts scrubEnv()  → CREDENTIAL_ENV_PREFIXES (env-var NAMES)
//   2. security/credentials.ts redactCredentials() → CREDENTIAL_KEY_PATTERNS (inline VALUES)
//
// Add new credential shapes here, not in the call sites.

/**
 * Env-var NAME prefixes that indicate the value is credential-bearing.
 * Used to filter the env passed to user hook commands.
 *
 * Pattern combines:
 *   - known provider/vendor prefixes (ANTHROPIC_*, OPENAI_*, etc.)
 *   - a generic suffix matcher catching anything ending in _KEY/_TOKEN/_SECRET/_PASS/_PASSWORD.
 */
export const CREDENTIAL_ENV_PREFIXES: RegExp =
  /^(ANTHROPIC_|OPENAI_|XAI_|CEREBRAS_|GROQ_|MISTRAL_|VOYAGE_|GOOGLE_|GEMINI_|AZURE_|HF_|HUGGINGFACE_|GH_|GITHUB_|GITLAB_|SLACK_|DISCORD_|BRAVE_|NOTION_|LINEAR_|VERCEL_|STRIPE_|SUPABASE_|AWS_|NPM_|SMTP_|IMAP_|DEEPSEEK_|MOONSHOT_|DASHSCOPE_|VOICE_TOOLS_|CUSTOM_).*|.*_(KEY|TOKEN|SECRET|PASS|PASSWORD)$/i;

/**
 * Inline secret-shape regexes. Each pattern captures the secret in group 1
 * (when feasible) so callers can mask just the credential and preserve context.
 * Patterns without a capture group match the whole secret (e.g. PEM blocks).
 */
export const CREDENTIAL_KEY_PATTERNS: readonly RegExp[] = [
  /\b(sk-ant-[a-zA-Z0-9_-]{20,})/g,        // Anthropic
  /\b(sk-[a-zA-Z0-9]{20,})/g,              // OpenAI
  /\b(ghp_[a-zA-Z0-9]{36,})/g,             // GitHub personal access token
  /\b(github_pat_[a-zA-Z0-9_]{20,})/g,     // GitHub fine-grained PAT
  /\b(gho_[a-zA-Z0-9]{36,})/g,             // GitHub OAuth
  /\b(ghs_[a-zA-Z0-9]{36,})/g,             // GitHub App installation
  /\b(xox[bpas]-[a-zA-Z0-9-]{20,})/g,      // Slack
  /\b(glpat-[a-zA-Z0-9_-]{20,})/g,         // GitLab
  /\b(AKIA[A-Z0-9]{16})/g,                 // AWS Access Key
  /\b(lin_api_[a-zA-Z0-9]{20,})/g,         // Linear
  /\b(sk_live_[a-zA-Z0-9]{20,})/g,         // Stripe live
  /\b(sk_test_[a-zA-Z0-9]{20,})/g,         // Stripe test
  /\b(sq0[a-z]{3}-[a-zA-Z0-9_-]{20,})/g,   // Square
  /\b(xai-[a-zA-Z0-9]{20,})/g,             // xAI
  /\b(vercel_[a-zA-Z0-9_-]{20,})/g,        // Vercel
  /\b(npm_[a-zA-Z0-9]{36,})/g,             // npm
  /\b(sbp_[a-zA-Z0-9]{20,})/g,             // Supabase
  /Bearer\s+([a-zA-Z0-9._\-]{20,})/gi,     // Bearer tokens
  /(?:api[_-]?key|token|secret|password|authorization|access_key|private_key)\s*[:=]\s*["']?([^\s"',]{12,})/gi,
  /(?:private[_-]?key|client[_-]?secret|signing[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9+/=]{40,})/gi,
  /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+|PGP\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+|PGP\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----/g,
];

/** Mask a secret value: prefix only, never suffix. */
function maskValue(value: string): string {
  if (value.length <= 12) return "[REDACTED]";
  return value.slice(0, 4) + "...[REDACTED]";
}

/**
 * Replace inline credentials in `text` with masked placeholders.
 * Use for tool output / log lines before they reach the model or persistent storage.
 *
 * Patterns with a capture group mask just the captured secret (preserving
 * surrounding label/punctuation); patterns without a capture group mask the
 * entire match (PEM blocks, etc.).
 */
export function redact(text: string): string {
  let result = text;
  for (const pattern of CREDENTIAL_KEY_PATTERNS) {
    const p = new RegExp(pattern.source, pattern.flags);
    result = result.replace(p, (match, captured) => {
      if (captured && captured.length > 12) {
        return match.replace(captured, maskValue(captured));
      }
      return maskValue(match);
    });
  }
  return result;
}
