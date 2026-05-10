// ═══════════════════════════════════════════════════════════════════
// DATA CLASSIFICATION — Tag tool results with sensitivity labels
// ═══════════════════════════════════════════════════════════════════

export type DataLabel =
  | "credentials"     // API keys, tokens, passwords
  | "pii"            // Names, emails, phone numbers, addresses
  | "secrets"        // Encryption keys, private keys
  | "financial"      // Credit card numbers, bank accounts
  | "internal_path"  // Internal file paths, system info
  | "code";          // Source code

export interface DataClassification {
  labels: DataLabel[];
  confidence: number; // 0.0 - 1.0
}

const CLASSIFICATION_PATTERNS: Array<{ label: DataLabel; pattern: RegExp; confidence: number }> = [
  // Credentials
  { label: "credentials", pattern: /\b(sk-|ghp_|github_pat_|xox[bpas]-|glpat-|AKIA|Bearer\s+[A-Za-z0-9])/i, confidence: 0.95 },
  { label: "credentials", pattern: /(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',]{8,}/i, confidence: 0.85 },
  { label: "credentials", pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/, confidence: 0.95 },  // Google API key
  { label: "credentials", pattern: /\b(ya29\.[0-9A-Za-z_-]+)\b/, confidence: 0.9 },     // Google OAuth token
  { label: "credentials", pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/, confidence: 0.85 },  // JWT
  // PII
  { label: "pii", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i, confidence: 0.8 },
  { label: "pii", pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, confidence: 0.7 },           // US phone
  { label: "pii", pattern: /\b\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/, confidence: 0.7 },  // International phone
  { label: "pii", pattern: /\(\d{3}\)\s*\d{3}[-.]?\d{4}\b/, confidence: 0.75 },           // (234) 567-8900
  { label: "pii", pattern: /\b\d{3}-\d{2}-\d{4}\b/, confidence: 0.95 },                   // SSN
  // Secrets — expanded PEM types
  { label: "secrets", pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/, confidence: 0.99 },
  { label: "secrets", pattern: /-----BEGIN\s+CERTIFICATE-----/, confidence: 0.8 },
  { label: "secrets", pattern: /-----BEGIN\s+PGP\s+PRIVATE\s+KEY\s+BLOCK-----/, confidence: 0.99 },
  // Financial — with basic Luhn pre-filter (length check)
  { label: "financial", pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/, confidence: 0.85 },
  { label: "financial", pattern: /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b/, confidence: 0.8 },  // Spaced card numbers
  // Internal paths
  { label: "internal_path", pattern: /[/\\]\.ssh[/\\]|[/\\]\.aws[/\\]|[/\\]\.env\b/i, confidence: 0.9 },
  { label: "internal_path", pattern: /[/\\]etc[/\\](passwd|shadow|hosts)\b/i, confidence: 0.9 },
];

/** Classify the content of a tool result */
export function classifyData(content: string): DataClassification {
  const labels = new Set<DataLabel>();
  let maxConfidence = 0;

  for (const { label, pattern, confidence } of CLASSIFICATION_PATTERNS) {
    if (pattern.test(content)) {
      labels.add(label);
      maxConfidence = Math.max(maxConfidence, confidence);
    }
  }

  return { labels: Array.from(labels), confidence: maxConfidence };
}
