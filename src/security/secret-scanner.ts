/**
 * Secrets Auto-Detection
 *
 * Scans outbound text for API key patterns, credentials,
 * and other secrets before they leave the system.
 *
 * The pattern catalog is NOT defined here — it lives in the canonical
 * credential-patterns.ts (CREDENTIAL_PATTERNS) so the inline redactor and
 * this position-aware scanner can never drift. Add new shapes there.
 */

import { CREDENTIAL_PATTERNS } from "./credential-patterns.js";

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

function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-4);
}

/** Scan text for secret patterns */
export function scanForSecrets(text: string): ScanResult {
  const matches: SecretMatch[] = [];

  for (const pattern of CREDENTIAL_PATTERNS) {
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
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) return true;
  }
  return false;
}

export type { ScanResult };
