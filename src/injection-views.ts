/**
 * Derived scan views for injection detection. Every consumer that pattern-
 * matches untrusted text (detectInjection, the memory taint gate) builds its
 * views HERE, so a bypass fixed for one consumer can't survive in another.
 * Pure text transforms — the pattern catalog lives in injection-patterns.ts,
 * the scoring engines in sanitize.ts.
 */
import { LEET_MAP } from "./injection-patterns.js";

/**
 * Leetspeak-normalized view of a string for injection scanning. Substitutes
 * digit/symbol leet chars back to letters, but ONLY inside alphanumeric tokens
 * that already contain a letter — so standalone numbers ("5 apples", "year
 * 2026") are left alone. This is a scan-only second view; never persist or
 * display its output. Note: it intentionally lets a leet spelling reach the same
 * patterns its plaintext would (e.g. "jailbr34k" → "jailbreak"), so leet-spelled
 * flagged terms are flagged just as plaintext is. Only digit leet is handled
 * (0 1 3 4 5 7 8 9 @ $); symbol maps like ()→o or +→t are deliberately excluded
 * — substituting bare +, |, ! would mangle ordinary text and code.
 */
export function deleet(text: string): string {
  return text.replace(/[a-z0-9@$]+/gi, (tok) => {
    if (!/[a-z]/i.test(tok)) return tok;
    if (!/[01345789@$]/.test(tok)) return tok;
    return tok.replace(/[01345789@$]/g, (c) => LEET_MAP[c] ?? c);
  });
}

/**
 * Strip intra-word separator characters so "Ig.no.re a.ll pr.ev.io.us
 * in.st.ru.ct.io.ns" collapses to "Ignore all previous instructions" and hits
 * the same patterns plaintext does. Only characters BETWEEN two letters are
 * removed — sentence-ending dots, decimals, and domains keep their meaning in
 * the ORIGINAL view, which is always scanned alongside this one (a derived
 * view can only ADD detections, never mask one).
 */
export function dedot(text: string): string {
  return text.replace(/(?<=[a-z])[.·•_-]+(?=[a-z])/gi, "");
}

/** The scan views every injection consumer shares: original + leetspeak +
 *  separator-stripped (+ combined). Building them in ONE place keeps
 *  detectInjection and the memory gate from drifting apart. */
export function injectionScanViews(normalized: string): string[] {
  const views = new Set<string>([normalized]);
  views.add(deleet(normalized));
  views.add(dedot(normalized));
  views.add(dedot(deleet(normalized)));
  return [...views];
}
