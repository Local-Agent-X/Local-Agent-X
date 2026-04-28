const REFUSAL_AND_ERROR_PATTERNS: RegExp[] = [
  /^(?:I'?m sorry|I apologi[sz]e|Sorry,)\b[^.\n]{0,200}\b(?:can'?t|cannot|unable|won'?t)\b/i,
  /^I (?:can'?t|cannot|am unable to|am not able to)\s+(?:help|assist|complete|provide|do|perform|access|fulfill|generate|produce|continue|comply)/i,
  /^I (?:don'?t|do not) have (?:access|the ability|permission|enough)/i,
  /^(?:Unable|Failed|Error)\s+to\s+(?:complete|access|fetch|connect|reach|generate|produce|retrieve|load)/i,
  /^ERROR:\s/i,
  /\brate[_\s-]?limit(?:ed| exceeded| reached)\b/i,
  /\bquota (?:exceeded|reached|limit)\b/i,
  /\b(?:invalid|missing|expired)\s+api[_\s-]?key\b/i,
  /\bauthentication failed\b/i,
];

export interface RefusalDetection {
  refused: boolean;
  pattern?: string;
}

export function detectRefusalOrError(text: string): RefusalDetection {
  const trimmed = text.trim();
  if (!trimmed) return { refused: false };
  // Only inspect the leading window to avoid false positives mid-report.
  const head = trimmed.slice(0, 600);
  for (const re of REFUSAL_AND_ERROR_PATTERNS) {
    if (re.test(head)) return { refused: true, pattern: re.source };
  }
  return { refused: false };
}
