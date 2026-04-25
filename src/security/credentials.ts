// ── Credential Redaction ──
// Masks secrets in tool output before they reach the LLM/chat

const REDACT_PATTERNS = [
  // Common API key prefixes (known formats)
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
  // Bearer tokens in output
  /Bearer\s+([a-zA-Z0-9._\-]{20,})/gi,
  // Key=value patterns (only for known sensitive keys)
  /(?:api[_-]?key|token|secret|password|authorization|access_key|private_key)\s*[:=]\s*["']?([^\s"',]{12,})/gi,
  // PEM private keys — all common types
  /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+|PGP\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+|PGP\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----/g,
  // Anthropic API keys
  /\b(sk-ant-[a-zA-Z0-9_-]{20,})/g,
  // Vercel tokens
  /\b(vercel_[a-zA-Z0-9_-]{20,})/g,
  // npm tokens
  /\b(npm_[a-zA-Z0-9]{36,})/g,
  // Supabase keys
  /\b(sbp_[a-zA-Z0-9]{20,})/g,
  // Generic long base64 secrets (40+ chars of base64 after a key-like label)
  /(?:private[_-]?key|client[_-]?secret|signing[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9+/=]{40,})/gi,
];

/** Mask a secret value: show only prefix for identification, never suffix */
function maskValue(value: string): string {
  if (value.length <= 12) return "[REDACTED]";
  // Show only first 4 chars for identification — never leak suffix
  return value.slice(0, 4) + "...[REDACTED]";
}

/** Redact potential credentials from a string before it reaches chat/LLM */
export function redactCredentials(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    const p = new RegExp(pattern.source, pattern.flags);
    result = result.replace(p, (match, captured) => {
      if (captured && captured.length > 12) {
        return match.replace(captured, maskValue(captured));
      }
      return match;
    });
  }
  return result;
}
