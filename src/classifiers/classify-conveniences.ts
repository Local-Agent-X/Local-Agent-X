/**
 * Convenience wrappers over classifyWithLLM — the yes/no, yes/no+reason, and
 * JSON-shaped entry points call sites actually use.
 *
 * Moved out of classify-with-llm.ts as a pure lift (that file sat AT the
 * 400-LOC source-hygiene ceiling): the core engine — provider routing plus
 * the wallclock race — stays there; these remain thin shapes over it.
 * classify-with-llm.ts re-exports everything here, so existing import sites
 * are unchanged.
 */
import { classifyWithLLM } from "./classify-with-llm.js";
import { stripCodeFences } from "./strip-code-fences.js";

/**
 * Convenience: yes/no classifier. Caller's prompt should ask the model to
 * reply with YES or NO on the first line. Returns boolean or null on failure.
 */
export async function classifyYesNo(args: {
  category: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  model?: string;
  envDisableVar?: string;
  signal?: AbortSignal;
}): Promise<boolean | null> {
  return classifyWithLLM<boolean>({
    ...args,
    parse: (raw) => {
      const m = raw.trim().match(/^\s*(YES|NO)\b/i);
      if (!m) return null;
      return m[1].toUpperCase() === "YES";
    },
  });
}

/**
 * Parse a "YES/NO + brief reason" reply into its verdict and justification.
 * Pure + exported for direct testing. The reason is everything after the
 * leading YES/NO token (and any separator), whitespace-collapsed and capped.
 * Returns null when the reply doesn't start with a YES/NO verdict.
 */
export function parseYesNoReason(raw: string): { verdict: boolean; reason: string } | null {
  const t = (raw ?? "").trim();
  const m = t.match(/^(YES|NO)\b/i);
  if (!m) return null;
  const verdict = m[1].toUpperCase() === "YES";
  const reason = t
    .slice(m[0].length)
    .replace(/^[\s:.\-–—]+/, "") // drop the separator between verdict and reason
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return { verdict, reason };
}

/**
 * Convenience: yes/no classifier that ALSO captures the model's one-line
 * reason. Same call shape as classifyYesNo, but the prompt should ask for a
 * brief reason after the verdict (e.g. "YES or NO followed by a brief reason").
 * Returns {verdict, reason} or null on failure/unavailability.
 */
export async function classifyYesNoWithReason(args: {
  category: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  model?: string;
  envDisableVar?: string;
  signal?: AbortSignal;
}): Promise<{ verdict: boolean; reason: string } | null> {
  return classifyWithLLM<{ verdict: boolean; reason: string }>({
    ...args,
    parse: parseYesNoReason,
  });
}

/**
 * Convenience: classifier that returns parsed JSON. Strips the common
 * markdown-fence wrap models sometimes emit even when told not to.
 */
export async function classifyJson<T>(args: {
  category: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  model?: string;
  maxResponseChars?: number;
  envDisableVar?: string;
  signal?: AbortSignal;
  /** Optional shape validator. Return T to accept, null to reject. Defaults to accept-as-is. */
  validate?: (parsed: unknown) => T | null;
}): Promise<T | null> {
  return classifyWithLLM<T>({
    ...args,
    parse: (raw) => {
      const cleaned = stripCodeFences(raw);
      try {
        const obj = JSON.parse(cleaned);
        if (args.validate) return args.validate(obj);
        return obj as T;
      } catch {
        return null;
      }
    },
  });
}
