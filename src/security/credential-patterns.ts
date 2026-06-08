// ── Credential pattern catalog ──
// Single source of truth for "what counts as a credential" across the codebase.
// Consumers today:
//   1. hooks/hook-engine.ts scrubEnv()      → CREDENTIAL_ENV_PREFIXES (env-var NAMES)
//   2. security/credentials.ts redactCredentials() → CREDENTIAL_KEY_PATTERNS (inline VALUES)
//   3. security/secret-scanner.ts            → CREDENTIAL_PATTERNS (position-aware scan)
//
// Add new credential shapes to CREDENTIAL_PATTERNS, not in the call sites.

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
 * A single credential shape. `type` is a coarse category and `name` a
 * human label — both surface in scanner results (security/secret-scanner.ts
 * SecretMatch) so consumers like exfil-scan and the http egress guard can
 * report WHICH credential leaked. `regex` captures the secret in group 1
 * where feasible (so callers can mask just the credential and preserve
 * surrounding context); patterns without a capture group match the whole
 * secret (e.g. PEM blocks).
 */
export interface CredentialPattern {
  type: string;
  name: string;
  regex: RegExp;
}

/**
 * The structured catalog — union of every credential shape recognized
 * across the codebase. Source of truth for both the inline-value redactor
 * (CREDENTIAL_KEY_PATTERNS, below) and the position-aware scanner.
 */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  // ── Provider / vendor API keys ──
  { type: "api_key", name: "Anthropic API Key", regex: /\b(sk-ant-[a-zA-Z0-9_-]{20,})/g },
  // OpenAI project/service/admin keys: a typed prefix then a CONTIGUOUS base62
  // body. The generic "OpenAI API Key" shape below stops at the `-` after
  // `proj`/`svcacct`/`admin`, so these scoped keys need their own entry. The
  // contiguous body (no inner `-`/`_`) keeps a hyphenated product slug like
  // `sk-supplement-formula-2026` from false-positiving. Listed BEFORE the
  // generic shape so the more-specific name wins in firstMatchName ordering.
  { type: "api_key", name: "OpenAI Scoped Key", regex: /\b(sk-(?:proj|svcacct|admin)-[A-Za-z0-9]{20,})/g },
  { type: "api_key", name: "OpenAI API Key", regex: /\b(sk-[a-zA-Z0-9]{20,})/g },
  { type: "api_key", name: "Google API Key", regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g },
  { type: "api_key", name: "xAI API Key", regex: /\b(xai-[a-zA-Z0-9]{20,})/g },
  { type: "api_key", name: "Stripe Live Key", regex: /\b(sk_live_[a-zA-Z0-9]{20,})/g },
  { type: "api_key", name: "Stripe Test Key", regex: /\b(sk_test_[a-zA-Z0-9]{20,})/g },
  { type: "api_key", name: "Sendgrid Key", regex: /\b(SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{20,})/g },
  { type: "api_key", name: "Linear API Key", regex: /\b(lin_api_[a-zA-Z0-9]{20,})/g },
  { type: "api_key", name: "WooCommerce Consumer Key", regex: /\b(ck_[a-f0-9]{40})\b/g },
  { type: "api_key", name: "WooCommerce Consumer Secret", regex: /\b(cs_[a-f0-9]{40})\b/g },
  { type: "api_key", name: "Square Token", regex: /\b(sq0[a-z]{3}-[a-zA-Z0-9_-]{20,})/g },
  { type: "api_key", name: "Vercel Token", regex: /\b(vercel_[a-zA-Z0-9_-]{20,})/g },
  { type: "api_key", name: "npm Token", regex: /\b(npm_[a-zA-Z0-9]{36,})/g },
  { type: "api_key", name: "Supabase Token", regex: /\b(sbp_[a-zA-Z0-9]{20,})/g },

  // ── Cloud provider ──
  { type: "cloud", name: "AWS Access Key", regex: /\b(AKIA[A-Z0-9]{16})/g },
  { type: "cloud", name: "AWS Secret Key", regex: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi },
  { type: "cloud", name: "GCP Service Account", regex: /"type"\s*:\s*"service_account"/g },

  // ── Version control ──
  { type: "vcs", name: "GitHub PAT", regex: /\b(ghp_[a-zA-Z0-9]{36,})/g },
  { type: "vcs", name: "GitHub Fine-grained PAT", regex: /\b(github_pat_[a-zA-Z0-9_]{20,})/g },
  { type: "vcs", name: "GitHub OAuth", regex: /\b(gho_[a-zA-Z0-9]{36,})/g },
  { type: "vcs", name: "GitHub App", regex: /\b(ghs_[a-zA-Z0-9]{36,})/g },
  { type: "vcs", name: "GitLab PAT", regex: /\b(glpat-[a-zA-Z0-9_-]{20,})/g },

  // ── Communication ──
  { type: "comm", name: "Slack Token", regex: /\b(xox[bpas]-[a-zA-Z0-9-]{20,})/g },
  { type: "comm", name: "Telegram Bot Token", regex: /\b(\d{8,10}:[A-Za-z0-9_-]{35})\b/g },
  { type: "comm", name: "Discord Token", regex: /([MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,})/g },

  // ── Cryptographic ──
  { type: "crypto", name: "Private Key (PEM)", regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+|PGP\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+|PGP\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----/g },
  // Bare PEM BEGIN marker. "Private Key (PEM)" above requires a matching END
  // block; a truncated/streamed key that shows only the header must still trip
  // (taint + egress). A bare BEGIN-PRIVATE-KEY line is never benign content.
  { type: "crypto", name: "Private Key Marker (PEM)", regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+|PGP\s+|DSA\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----/g },
  { type: "crypto", name: "Certificate", regex: /-----BEGIN\s+CERTIFICATE-----/g },
  // JWT: three base64url segments. The leading `eyJ` is base64url of `{"`, so a
  // JWT header/payload always starts there — a strong, low-FP anchor. Gates
  // egress now too: a model-emitted JWT in an outbound body is a token leak.
  { type: "crypto", name: "JWT", regex: /\b(eyJ[A-Za-z0-9_-]{18,}\.eyJ[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{18,})/g },

  // ── Database ──
  { type: "database", name: "Database Connection String", regex: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']{10,}/gi },

  // ── Generic shapes ──
  { type: "generic", name: "Bearer Token", regex: /Bearer\s+([a-zA-Z0-9._\-]{20,})/gi },
  { type: "generic", name: "Password in URL", regex: /\/\/[^:]+:[^@]+@[^\s/]+/g },
  { type: "generic", name: "Key-Value Secret", regex: /(?:api[_-]?key|token|secret|password|authorization|access_key|private_key)\s*[:=]\s*["']?([^\s"',]{12,})/gi },
  { type: "generic", name: "Base64 Secret Assignment", regex: /(?:private[_-]?key|client[_-]?secret|signing[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9+/=]{40,})/gi },
];

/**
 * Flat list of just the regexes, derived from the structured catalog.
 * Kept for the inline-value redactor in security/credentials.ts and the
 * `redact()` helper below — callers that don't need the type/name metadata.
 */
export const CREDENTIAL_KEY_PATTERNS: readonly RegExp[] = CREDENTIAL_PATTERNS.map((p) => p.regex);

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
