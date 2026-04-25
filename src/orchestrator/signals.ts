import type { ModuleSignal } from "./types.js";
import { MAX_CONTEXT_SIGNALS } from "./types.js";
import { resolveConflicts } from "./fusion.js";

export function hashSignal(s: ModuleSignal): string {
  return s.category + ":" + s.signal.slice(0, 40);
}

export function mergeSignals(signals: ModuleSignal[], previousHashes: string[]): { paragraph: string; usedSignals: ModuleSignal[]; hashes: string[] } {
  const sorted = [...signals].sort((a, b) => b.priority - a.priority);

  const seen = new Set<string>();
  const deduped: ModuleSignal[] = [];
  for (const sig of sorted) {
    const catCount = deduped.filter(s => s.category === sig.category).length;
    if (catCount >= 2) continue;

    const hash = hashSignal(sig);
    if (seen.has(hash)) continue;
    seen.add(hash);
    deduped.push(sig);
  }

  const prevSet = new Set(previousHashes);
  const fresh = deduped.filter(s => !prevSet.has(hashSignal(s)));
  const candidates = fresh.length > 0 ? fresh : deduped;

  const resolved = resolveConflicts(candidates);

  const top = resolved.slice(0, MAX_CONTEXT_SIGNALS);

  const paragraph = buildParagraph(top);

  return {
    paragraph,
    usedSignals: top,
    hashes: top.map(hashSignal),
  };
}

export function sanitizeSignal(raw: string): string {
  let s = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  s = s.replace(/\[(?:system|assistant|user|INST)\][\s:]/gi, "");
  s = s.replace(/<\/?(?:system|assistant|user|s|im_start|im_end)[^>]*>/gi, "");
  return s;
}

export function buildParagraph(signals: ModuleSignal[]): string {
  if (signals.length === 0) return "";

  const parts: string[] = [];

  const critical = signals.filter(s => s.category === "vulnerability" || s.category === "correction" || s.category === "correction-context");
  const emotional = signals.filter(s => s.category === "emotion" || s.category === "emotion-shift");
  const relational = signals.filter(s => s.category === "trust" || s.category === "trust-behavior" || s.category === "history");
  const contextual = signals.filter(s => s.category === "reference" || s.category === "recall" || s.category === "narrative" || s.category === "followup" || s.category === "proactive");
  const observational = signals.filter(s => s.category === "style" || s.category === "growth" || s.category === "pattern" || s.category === "milestone" || s.category === "unspoken" || s.category === "behavior-change" || s.category === "contradiction");

  for (const sig of critical) parts.push(sanitizeSignal(sig.signal));
  for (const sig of emotional) parts.push(sanitizeSignal(sig.signal));
  for (const sig of relational.slice(0, 1)) parts.push(sanitizeSignal(sig.signal));
  for (const sig of contextual.slice(0, 2)) parts.push(sanitizeSignal(sig.signal));
  for (const sig of observational.slice(0, 2)) parts.push(sanitizeSignal(sig.signal));

  if (parts.length === 0) return "";

  let text = parts
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => p.endsWith(".") || p.endsWith("!") || p.endsWith("?") ? p : p + ".")
    .join(" ");

  if (text.length > 800) {
    text = text.slice(0, 797) + "...";
  }

  return text;
}
