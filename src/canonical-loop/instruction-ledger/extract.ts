/**
 * Constraint extractor — turns ONE user message into an InstructionLedger.
 *
 * Two stages, tuned for HIGH PRECISION over recall (a missed constraint is a
 * nudge we don't give; an invented one spuriously blocks an unconstrained op):
 *
 *  1. PHRASE GATE (sync, deterministic): a conservative regex prefilter for
 *     prohibition/obligation cues. No cue → EMPTY ledger immediately, zero
 *     LLM calls — the overwhelmingly common path.
 *  2. LLM CONFIRM (only on a gate hit): the current provider's background
 *     model (via classifyJson) maps each cued phrase to a CapabilityClass
 *     prohibition or a commit-when-done obligation, and rejects gate
 *     false-positives ("never mind, run the tests" is not a constraint).
 *
 * FAIL-OPEN, NEVER throws: on ANY LLM failure/timeout/null the extractor
 * falls back to the gate's STRONG tier — only the unambiguous direct
 * negations ("don't edit …" → workspace-write) and the commit-when-done
 * obligation cue — else the empty ledger. An empty/absent LLM must never
 * make the harness stricter than the deterministic gate alone.
 *
 * The confirm call is injectable (default param) so tests run without a
 * network; the default routes through src/classifiers/classify-with-llm.ts.
 */
import type { InstructionLedger, Obligation } from "./ledger.js";
// CapabilityClass lives in tool-registry (ledger.ts imports it from there too
// and doesn't re-export it) — same canonical source, no new seam.
import type { CapabilityClass } from "../../tool-registry.js";
import { classifyJson } from "../../classifiers/classify-with-llm.js";

/** What the LLM (or an injected test double) confirms from the gated cues. */
export interface ConfirmedConstraints {
  prohibitions: CapabilityClass[];
  obligations: Obligation[];
}

export type ConfirmConstraintsFn = (
  userMessage: string,
  cues: string[],
) => Promise<ConfirmedConstraints | null>;

// ---------------------------------------------------------------------------
// Stage 1 — phrase gate
// ---------------------------------------------------------------------------

// Action verbs a negation cue can attach to. Present/gerund forms only —
// past tense ("edited", "pushed") never follows "don't/without" and would
// only add narration false-positives.
const ACTION_VERB =
  "(?:edit(?:s|ing)?|modif(?:y|ies|ying)|chang(?:e|es|ing)|touch(?:es|ing)?" +
  "|writ(?:e|es|ing)|commit(?:s|ting)?|push(?:es|ing)?|brows(?:e|es|ing)" +
  "|open(?:s|ing)?\\s+(?:the\\s+|a\\s+)?browser|run(?:s|ning)?|install(?:s|ing)?|read(?:s|ing)?)";

// Negation cue within the same sentence (no ./?/!/newline crossing) and a
// short window of the verb. Window kept tight — the gate only decides
// whether to spend an LLM call, the confirm stage owns final precision.
const PROHIBITION_CUE = new RegExp(
  `\\b(?:don['’]?t|do\\s+not|never|without|no\\s+need\\s+to)\\b[^.?!\\n]{0,50}?\\b${ACTION_VERB}\\b`,
  "gi",
);

// Read-only-intent phrasings that don't name a verb.
const STANDALONE_CUES: RegExp[] = [
  /\bread-?only\b/gi,
  /\b(?:just|only)\s+tell\s+me\b/gi,
  /\b(?:don['’]?t|do\s+not)\s+do\s+anything\b/gi,
  /\bI['’]?ll\s+(?:verify|test|run|handle)\b[^.?!\n]{0,20}?\bmyself\b/gi,
];

// End-of-op obligation cues. Both are unambiguous → also the strong tier.
const OBLIGATION_CUES: RegExp[] = [
  /\bcommit\b[^.?!\n]{0,30}?\bwhen\s+(?:you['’]?re\s+|you\s+are\s+)?done\b/gi,
  /\bcheck\s+(?:it|this|them)\s+in\s+when\s+(?:you['’]?re\s+|you\s+are\s+)?done\b/gi,
];

// STRONG tier: direct negation-verb adjacency only — the phrasings whose
// CapabilityClass is unambiguous without a model. This is the entire
// LLM-failure fallback, so it stays deliberately narrow: "don't commit",
// "don't run the tests", "read-only" all gate but are NOT strong (their
// class/scope is the LLM's call).
const STRONG_PROHIBITIONS: ReadonlyArray<{ re: RegExp; cls: CapabilityClass }> = [
  { re: /\b(?:don['’]?t|do\s+not|never)\s+(?:edit|modify|change|touch|write|rewrite)\b/gi, cls: "workspace-write" },
  { re: /\b(?:don['’]?t|do\s+not|never)\s+(?:browse|open\s+(?:the\s+|a\s+)?browser|go\s+online|use\s+the\s+(?:web|internet))\b/gi, cls: "egress" },
  { re: /\b(?:don['’]?t|do\s+not|never)\s+(?:install\b|run\s+(?:any(?:thing)?|commands?|shell|bash|scripts?)\b)/gi, cls: "shell" },
  { re: /\b(?:don['’]?t|do\s+not|never)\s+read\s+(?:my\s+|the\s+)?(?:secrets?|credentials?|\.?env\b|passwords?|keys?)/gi, cls: "sensitive-read" },
];

export interface PhraseGateResult {
  /** Literal cue substrings matched in the message; empty = no gate hit. */
  cues: string[];
  /** Constraints the cues imply unambiguously — the LLM-failure fallback. */
  strong: ConfirmedConstraints;
}

/** Pure + exported for direct testing. */
export function phraseGate(userMessage: string): PhraseGateResult {
  const cues: string[] = [];
  const seen = new Set<string>();
  const collect = (re: RegExp) => {
    for (const m of userMessage.match(re) ?? []) {
      const key = m.trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        cues.push(m.trim());
      }
    }
  };
  collect(PROHIBITION_CUE);
  for (const re of STANDALONE_CUES) collect(re);
  for (const re of OBLIGATION_CUES) collect(re);

  const strong: ConfirmedConstraints = { prohibitions: [], obligations: [] };
  for (const { re, cls } of STRONG_PROHIBITIONS) {
    if (re.test(userMessage) && !strong.prohibitions.includes(cls)) strong.prohibitions.push(cls);
    re.lastIndex = 0; // /g regex reused via .test — reset between calls
  }
  if (OBLIGATION_CUES.some((re) => userMessage.match(re) !== null)) {
    strong.obligations.push({ kind: "commit-when-done" });
  }
  return { cues, strong };
}

// ---------------------------------------------------------------------------
// Stage 2 — LLM confirm
// ---------------------------------------------------------------------------

const VALID_CLASSES: ReadonlySet<string> = new Set([
  "workspace-write",
  "egress",
  "shell",
  "sensitive-read",
]);

const SYSTEM_PROMPT = `You audit ONE user message sent to an autonomous coding agent for EXPLICIT run constraints the user stated. Reply with ONLY minified JSON, no prose, no fences:
{"prohibitions":[],"obligations":[]}

prohibitions — capability classes the user FORBADE for this task. Allowed values only:
- "workspace-write": forbade editing/modifying/writing/touching files or code (e.g. "don't edit any code", "read-only", "just tell me what's wrong")
- "egress": forbade browsing / opening the browser / going online
- "shell": forbade running shell/bash commands or installing anything
- "sensitive-read": forbade reading certain files/secrets/credentials

obligations — allowed value only "commit-when-done": the user asked to commit / check the work in when done.

HIGH PRECISION RULES:
- Include a constraint ONLY when the user EXPLICITLY stated it as an instruction for THIS task.
- Narration ("I never run the tests"), questions, and negations about outcomes ("don't break the build") are NOT constraints.
- "I'll test/verify/run/handle it myself" implies the agent should not do that step itself — map to the matching class.
- When in doubt, return empty arrays.`;

async function llmConfirm(
  userMessage: string,
  cues: string[],
): Promise<ConfirmedConstraints | null> {
  return classifyJson<ConfirmedConstraints>({
    category: "constraint-extract",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      `USER MESSAGE:\n"""${userMessage.slice(0, 4000)}"""\n\n` +
      `PHRASES THAT TRIPPED THE PREFILTER (may be false alarms):\n${cues
        .map((c) => `  - "${c}"`)
        .join("\n")}\n\nJSON:`,
    // Fires only on a gated message, so a small budget; a timeout falls back
    // to the deterministic strong tier without ever blocking the op.
    timeoutMs: 1500,
    envDisableVar: "LAX_LLM_CONSTRAINT_EXTRACT",
    validate: validateConfirmation,
  });
}

/**
 * Strict shape validator for the model's JSON: unknown class names and
 * unknown obligation kinds are dropped (not rejected wholesale — a partial
 * valid answer beats a null). Exported for direct testing.
 */
export function validateConfirmation(parsed: unknown): ConfirmedConstraints | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { prohibitions?: unknown; obligations?: unknown };
  if (!Array.isArray(obj.prohibitions) || !Array.isArray(obj.obligations)) return null;
  const prohibitions: CapabilityClass[] = [];
  for (const p of obj.prohibitions) {
    if (typeof p === "string" && VALID_CLASSES.has(p) && !prohibitions.includes(p as CapabilityClass)) {
      prohibitions.push(p as CapabilityClass);
    }
  }
  const obligations: Obligation[] = obj.obligations.some((o) => o === "commit-when-done")
    ? [{ kind: "commit-when-done" }]
    : [];
  return { prohibitions, obligations };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function emptyLedger(): InstructionLedger {
  return { prohibitions: [], obligations: [], phrases: [] };
}

/**
 * Extract the user's explicit run constraints from one message. Returns an
 * EMPTY ledger for the unconstrained common case (no LLM call), and never
 * throws — any confirm failure degrades to the gate's strong tier or empty.
 */
export async function extractConstraints(
  userMessage: string,
  confirm: ConfirmConstraintsFn = llmConfirm,
): Promise<InstructionLedger> {
  if (typeof userMessage !== "string" || !userMessage.trim()) return emptyLedger();

  const gate = phraseGate(userMessage);
  if (gate.cues.length === 0) return emptyLedger(); // no cue → no LLM, empty

  let confirmed: ConfirmedConstraints | null = null;
  try {
    confirmed = await confirm(userMessage, gate.cues);
  } catch {
    confirmed = null; // fail open — treated exactly like an LLM timeout
  }

  // LLM unavailable/failed → only the unambiguous deterministic tier stands.
  const result = confirmed ?? gate.strong;
  if (result.prohibitions.length === 0 && result.obligations.length === 0) {
    return emptyLedger(); // confirm rejected the cues (or nothing was strong)
  }
  return {
    prohibitions: [...result.prohibitions],
    obligations: [...result.obligations],
    phrases: gate.cues,
  };
}
