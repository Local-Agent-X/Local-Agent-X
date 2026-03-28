/**
 * Secrets Auto-Detection
 *
 * Scans outbound text for API key patterns, credentials,
 * and other secrets before they leave the system.
 */

export interface SecretMatch {
  type: string;
  pattern: string;
  value: string;
  masked: string;
  startIndex: number;
  endIndex: number;
}

interface ScanResult {
  clean: boolean;
  matches: SecretMatch[];
  scannedLength: number;
}

interface SecretPattern {
  type: string;
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // API Keys
  { type: "api_key", name: "OpenAI API Key", regex: /\bsk-[a-zA-Z0-9]{20,}/g },
  { type: "api_key", name: "Anthropic API Key", regex: /\bsk-ant-[a-zA-Z0-9_-]{20,}/g },
  { type: "api_key", name: "xAI API Key", regex: /\bxai-[a-zA-Z0-9]{20,}/g },
  { type: "api_key", name: "Stripe Live Key", regex: /\bsk_live_[a-zA-Z0-9]{20,}/g },
  { type: "api_key", name: "Stripe Test Key", regex: /\bsk_test_[a-zA-Z0-9]{20,}/g },
  { type: "api_key", name: "Sendgrid Key", regex: /\bSG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{20,}/g },
  { type: "api_key", name: "Linear API Key", regex: /\blin_api_[a-zA-Z0-9]{20,}/g },

  // Cloud Provider
  { type: "cloud", name: "AWS Access Key", regex: /\bAKIA[A-Z0-9]{16}\b/g },
  { type: "cloud", name: "AWS Secret Key", regex: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi },
  { type: "cloud", name: "GCP Service Account", regex: /"type"\s*:\s*"service_account"/g },

  // Version Control
  { type: "vcs", name: "GitHub PAT", regex: /\bghp_[a-zA-Z0-9]{36,}/g },
  { type: "vcs", name: "GitHub Fine-grained PAT", regex: /\bgithub_pat_[a-zA-Z0-9_]{20,}/g },
  { type: "vcs", name: "GitHub OAuth", regex: /\bgho_[a-zA-Z0-9]{36,}/g },
  { type: "vcs", name: "GitHub App", regex: /\bghs_[a-zA-Z0-9]{36,}/g },
  { type: "vcs", name: "GitLab PAT", regex: /\bglpat-[a-zA-Z0-9_-]{20,}/g },

  // Communication
  { type: "comm", name: "Slack Token", regex: /\bxox[bpas]-[a-zA-Z0-9-]{20,}/g },
  { type: "comm", name: "Telegram Bot Token", regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { type: "comm", name: "Discord Token", regex: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/g },

  // Cryptographic
  { type: "crypto", name: "Private Key (PEM)", regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g },
  { type: "crypto", name: "Certificate", regex: /-----BEGIN\s+CERTIFICATE-----/g },

  // Database
  { type: "database", name: "Database Connection String", regex: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']{10,}/gi },

  // Generic patterns
  { type: "generic", name: "Bearer Token", regex: /Bearer\s+[a-zA-Z0-9._\-]{20,}/gi },
  { type: "generic", name: "Password in URL", regex: /\/\/[^:]+:[^@]+@[^\s/]+/g },
  { type: "generic", name: "Key-Value Secret", regex: /(?:api[_-]?key|token|secret|password|auth[_-]?token)\s*[:=]\s*["']?[^\s"',]{16,}/gi },
];

function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-4);
}

/** Scan text for secret patterns */
export function scanForSecrets(text: string): ScanResult {
  const matches: SecretMatch[] = [];

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const value = match[1] || match[0];
      matches.push({
        type: pattern.type,
        pattern: pattern.name,
        value: value.slice(0, 20) + (value.length > 20 ? "..." : ""),
        masked: maskSecret(value),
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }
  }

  // Deduplicate by position
  const seen = new Set<string>();
  const deduped = matches.filter(m => {
    const key = `${m.startIndex}:${m.endIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    clean: deduped.length === 0,
    matches: deduped,
    scannedLength: text.length,
  };
}

/** Redact all detected secrets from text */
export function redactSecrets(text: string): string {
  const result = scanForSecrets(text);
  if (result.clean) return text;

  let redacted = text;
  // Process from end to start to maintain indices
  const sorted = [...result.matches].sort((a, b) => b.startIndex - a.startIndex);
  for (const match of sorted) {
    const before = redacted.slice(0, match.startIndex);
    const after = redacted.slice(match.endIndex);
    redacted = before + `[REDACTED:${match.pattern}]` + after;
  }
  return redacted;
}

/** Check if text contains any secrets (quick boolean check) */
export function containsSecrets(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) return true;
  }
  return false;
}

export type { ScanResult };
