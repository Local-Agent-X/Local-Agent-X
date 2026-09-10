/**
 * Memory Taint Protection — pure extraction, split out of sanitize.ts when it
 * crossed the hard 400-LOC source-hygiene ceiling (scripts/check-source-hygiene.mjs).
 * sanitize.ts keeps the general content-sanitization engine (stripping,
 * detection, wrapExternalContent); this module owns the one thing specific to
 * persisting content into high-trust memory/profile files: deciding whether
 * it's safe to write at all.
 *
 * Prevents untrusted external content from being persisted into high-trust
 * memory/profile files, which would create permanent instruction hijacks
 * (durable prompt injection): malicious webpage → agent reads it →
 * memory_save → permanent instruction hijack.
 *
 * Re-exported from sanitize.ts so existing `import { checkMemoryTaint } from
 * "./sanitize.js"` call sites keep working unchanged.
 */
import {
  INJECTION_PATTERNS,
  EXTERNAL_MARKERS,
  MEMORY_INJECTION_EXTRA,
  MEMORY_BLOCK_SINGLE,
  MEMORY_BLOCK_CUMULATIVE,
  MEMORY_SOAK_ADMIT_CEIL,
} from "./injection-patterns.js";
import { injectionScanViews } from "./injection-views.js";
import { MAX_INJECTION_SCAN_LENGTH } from "./safe-regex.js";
import { stripControlChars, normalizeHomoglyphs } from "./sanitize.js";
import { createLogger } from "./logger.js";

const logger = createLogger("sanitize.memory-taint");

export interface MemoryTaintResult {
  safe: boolean;
  reason?: string;
  injectionScore: number;
}

/**
 * Check if content is safe to persist to memory/profile files.
 * Returns safe=false if the content looks like it came from an external
 * source or contains instruction injection patterns.
 *
 * This prevents the attack chain:
 *   malicious webpage → agent reads it → memory_save → permanent instruction hijack
 */
export function checkMemoryTaint(content: string): MemoryTaintResult {
  // Inspect the full content the caller is about to persist — a poisoning
  // directive anywhere in it must block the write, not just one in the first N KB.
  // MAX_INJECTION_SCAN_LENGTH is only a stall backstop for a pathological unbounded
  // input; it sits above every real caller's content cap.
  const scanned = content.length > MAX_INJECTION_SCAN_LENGTH ? content.slice(0, MAX_INJECTION_SCAN_LENGTH) : content;
  // FIRST: normalize unicode tricks that could bypass pattern matching
  // This closes the homoglyph/invisible-char bypass the audit identified
  const normalized = normalizeHomoglyphs(stripControlChars(scanned)).normalize('NFKC');
  // Shared derived views — the same builder detectInjection uses (leetspeak +
  // separator-stripped), so a directive hidden in leet ("y0ur 0wn 1n57ruc75")
  // or dot-separation ("in.st.ru.ct.io.ns") can't slip the memory gate while
  // being caught upstream, or vice versa.
  const views = injectionScanViews(normalized);

  // Check for external content markers (wrapped content leaking into memory)
  for (const marker of EXTERNAL_MARKERS) {
    if (marker.test(normalized)) {
      return {
        safe: false,
        reason: "Content contains external/untrusted source markers. External content cannot be saved to memory.",
        injectionScore: 0.95,
      };
    }
  }

  // Score against the canonical injection-pattern list (same one detectInjection
  // uses) so the memory gate can't drift behind it. Each pattern carries its own
  // confidence; a single strong hit blocks, and weaker hits accumulate. Each
  // label is counted once even if it hits in both views.
  let cumulative = 0;
  let maxScore = 0;
  const matches: string[] = [];
  const counted = new Set<string>();
  for (const { pattern, score, label } of [...INJECTION_PATTERNS, ...MEMORY_INJECTION_EXTRA]) {
    if (counted.has(label)) continue;
    if (views.some((v) => pattern.test(v))) {
      cumulative += score;
      maxScore = Math.max(maxScore, score);
      matches.push(label);
      counted.add(label);
    }
  }
  const injectionScore = Math.min(Math.max(cumulative, maxScore), 1.0);

  if (maxScore >= MEMORY_BLOCK_SINGLE || cumulative >= MEMORY_BLOCK_CUMULATIVE) {
    // Band observability (pure measurement — does NOT change this block). A
    // cumulative-only block (no strong single pattern) whose score would be
    // ADMITTED under a hypothetical 0.6 gate is a "would-admit-at-0.6 candidate".
    // Logging the score + matched labels (never the memory content) measures the
    // benign-vs-malicious mix in [0.3, 0.6) so a future threshold decision uses
    // real data instead of guessing. The write is still blocked here, exactly as
    // the 0.3 gate always did.
    if (maxScore < MEMORY_BLOCK_SINGLE && cumulative < MEMORY_SOAK_ADMIT_CEIL) {
      logger.warn(
        `would-admit-at-0.6 candidate: score=${cumulative.toFixed(2)} labels=[${matches.join(", ")}]`,
      );
    }
    return {
      safe: false,
      reason: `Content has high injection score (${injectionScore.toFixed(2)}). ` +
        `Patterns: ${matches.slice(0, 3).join(", ")}. ` +
        `This looks like an attempt to inject persistent instructions.`,
      injectionScore,
    };
  }

  return { safe: true, injectionScore };
}

/**
 * Sanitize content before writing to memory/profile files.
 * Strips external markers and control characters, but does NOT block —
 * use checkMemoryTaint() first to decide whether to block entirely.
 */
export function sanitizeForMemory(content: string): string {
  let result = stripControlChars(content);
  result = normalizeHomoglyphs(result);
  // Strip any external content wrapper markers that leaked through
  result = result.replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, "[external content removed]");
  result = result.replace(/<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, "");
  result = result.replace(/<metadata>[\s\S]*?<\/metadata>/gi, "");
  result = result.replace(/<content>\n?/gi, "").replace(/\n?<\/content>/gi, "");
  return result.trim();
}
