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

// Verbless prohibition phrasings. GATE-ONLY on purpose: every entry routes the
// message to the LLM confirm, and NONE contributes to the strong tier — on an
// LLM outage these cues yield nothing (fail-open), because their class/scope is
// genuinely ambiguous without a model ("the volume is read-only" describes,
// "no changes to report" narrates). Widening THIS list costs at most a spare
// LLM call the confirm stage can reject; widening STRONG_PROHIBITIONS — the
// LLM-outage determinism floor — is what's forbidden.
const STANDALONE_CUES: RegExp[] = [
  // read-only intent
  /\bread[- ]?only\b/gi,
  /\b(?:just|only)\s+tell\s+me\b/gi,
  /\bjust\s+(?:look|review|analy[sz]e)\b/gi,
  /\b(?:look|review|analysis)\s+only\b/gi,
  /\b(?:don['’]?t|do\s+not)\s+do\s+anything\b/gi,
  /\bI['’]?ll\s+(?:verify|test|run|handle)\b[^.?!\n]{0,20}?\bmyself\b/gi,
  // keep-as-is: "leave <x> as it is / as they are / alone / untouched",
  // "keep <x> as is", bare hyphenated "as-is". The leave/keep patterns require
  // the trailing anchor so "leave a comment" / "keep it simple" don't gate.
  /\bleave\b[^.?!\n]{0,40}?\b(?:as\s+(?:it\s+is|they\s+are)|alone|untouched)\b/gi,
  /\bkeep\b[^.?!\n]{0,40}?\bas[- ]is\b/gi,
  /\bas-is\b/gi,
  // hands-off
  /\bhands[- ]off\b/gi,
  /\b(?:no|zero)\s+changes\b/gi,
  /\bnothing\s+(?:gets|is|should\s+be|will\s+be)\s+(?:modified|changed|edited)\b/gi,
];

// End-of-op obligation cues. Both are unambiguous → also the strong tier.
const OBLIGATION_CUES: RegExp[] = [
  /\bcommit\b[^.?!\n]{0,30}?\bwhen\s+(?:you['’]?re\s+|you\s+are\s+)?done\b/gi,
  /\bcheck\s+(?:it|this|them)\s+in\s+when\s+(?:you['’]?re\s+|you\s+are\s+)?done\b/gi,
];

// "Read/look at/check X before you answer" — a consult-before-answering
// obligation. Unambiguous as an instruction (both orderings), so it also joins
// the strong tier: an obligation nudge is low-risk to over-fire, and it must not
// vanish on an LLM outage any more than commit-when-done does.
// The gap tolerates a dot ONLY as a filename extension (`.ts`, `.json` — a dot
// followed by a word char), never a sentence-ending period — so "read parser.ts
// before you answer" spans the filename while "read the docs. Before lunch…"
// still can't cross the sentence boundary.
const GAP = String.raw`(?:[^.?!\n]|\.\w)`;
const READ_FIRST_CUES: RegExp[] = [
  new RegExp(String.raw`\b(?:read|look\s+at|check|review|inspect|consult|examine)\b${GAP}{0,45}?\bbefore\b${GAP}{0,25}?(?:answer|respond|repl(?:y|ying)|tell(?:ing)?\s+me|conclud|decid)`, "gi"),
  new RegExp(String.raw`\bbefore\s+(?:you\s+)?(?:answer(?:ing)?|respond(?:ing)?|repl(?:y|ying)|conclud|decid)${GAP}{0,30}?\b(?:read|look\s+at|check|review|inspect|consult|examine)\b`, "gi"),
];

// The file the user named to read ("read parser.ts before you answer" → the
// token `parser.ts`). Captures a token bearing a filename extension or a path
// slash, right after a read verb (an optional article/quote between). Returns
// the basename STEM ("parser") — matched loosely against what the op actually
// read, mirroring the eval's consultedFile check so the guard and the eval can't
// drift. Undefined when no concrete file was named (the audit then accepts any
// read). Exported for direct testing.
const READ_TARGET_RE =
  /\b(?:read|look\s+at|check|review|inspect|consult|examine)\s+(?:the\s+|at\s+|into\s+|through\s+)?[`'"]?([A-Za-z0-9._@/-]*(?:\.[A-Za-z0-9]+|\/[A-Za-z0-9._-]+))[`'"]?/i;
export function extractReadTarget(userMessage: string): string | undefined {
  const m = userMessage.match(READ_TARGET_RE);
  if (!m) return undefined;
  const base = m[1].split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.[A-Za-z0-9]+$/, "");
  return stem.length >= 3 ? stem : undefined;
}

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
  // Unambiguous standalone "don't act / diagnose-only" forms — promoted to the
  // strong tier so the most important constraint survives an LLM outage. Kept
  // narrow on purpose: "don't do anything" can't read as description, and
  // "just tell me WHAT/WHY/HOW…" is diagnostic (it excludes the temporal
  // "just tell me WHEN you're done", which means notify, not read-only). Bare
  // "read-only" and "I'll do it myself" are deliberately NOT here — their
  // class/scope is genuinely ambiguous ("the filesystem is read-only") and a
  // wrong strong guess would over-block, which the no-over-block invariant forbids;
  // they stay LLM-gated, and fail-open (no enforcement) is the safe degrade.
  { re: /\b(?:don['’]?t|do\s+not)\s+do\s+anything\b/gi, cls: "workspace-write" },
  { re: /\b(?:just|only)\s+tell\s+me\s+(?:what|which|where|why|how|if|whether)\b/gi, cls: "workspace-write" },
];

// A prohibition whose object is a PARTITIVE / "leave-the-rest-alone" referent —
// "don't change any OTHER feature", "don't touch the REST", "don't edit anything
// ELSE". This is logically NEVER a whole-workspace write ban: the words other /
// rest / else only mean something if the task IS editing the non-other subset.
// So a `workspace-write` prohibition from such a phrase is always a spurious
// over-block (it bricks the very edits the task asked for — the exact "invented
// constraint blocks an unconstrained op" failure this module warns about). The
// veto is deliberately NARROW — it fires only on an explicit partitive object,
// so "don't touch the config" / "don't touch main.ts" (whole-session read-only
// intents the strong tier deliberately keeps) are untouched. Fail-open-safe:
// dropping it can at worst miss a nudge, never brick a write task.
const SCOPED_WRITE_CARVEOUT =
  /\b(?:don['’]?t|do\s+not|never)\s+(?:edit|modif(?:y|ies)|chang(?:e|es)|touch(?:es)?|writ(?:e|es)|rewrite|remove|delete|alter)\b[^.?!\n]{0,40}?\b(?:other|others|the\s+rest|remaining|(?:any|every)thing\s+else)\b/i;

/** True when the message forbids editing only a "leave-the-rest-alone" subset,
 *  which can never be a blanket workspace-write ban. Exported for direct tests. */
export function isScopedWriteCarveout(userMessage: string): boolean {
  return SCOPED_WRITE_CARVEOUT.test(userMessage);
}

// The strong-tier regexes that imply workspace-write — reused to detect an
// INDEPENDENT read-only ban once the carve-out phrase is removed.
const WS_WRITE_STRONG = STRONG_PROHIBITIONS.filter((s) => s.cls === "workspace-write");

/** True when, ignoring the carve-out phrase, the message still carries a strong
 *  workspace-write cue of its own (e.g. "just tell me what's wrong"). */
function hasIndependentWorkspaceWriteCue(message: string): boolean {
  return WS_WRITE_STRONG.some((s) => {
    s.re.lastIndex = 0; // /g regex reused via .test — reset between calls
    return s.re.test(message);
  });
}

/** Drop a spurious `workspace-write` prohibition that came from a partitive
 *  carve-out ("don't change anything ELSE") — but ONLY when the carve-out is its
 *  sole source. If a separate, unambiguous read-only cue stands beside it
 *  ("just tell me what's wrong; don't change anything else"), the ban is real and
 *  is kept. Strip-and-recheck is the only attribution a regex has: the carve-out
 *  text also matches the don't-change strong pattern, so per-phrase attribution
 *  isn't possible. DETERMINISTIC TIER ONLY — called from phraseGate on the
 *  strong prohibitions, never on an LLM-confirmed result: the model saw the full
 *  message, carve-out included, and judges it itself (see extractConstraints).
 *  Other classes and obligations pass through untouched. */
function vetoScopedWrite(prohibitions: readonly CapabilityClass[], userMessage: string): CapabilityClass[] {
  if (!isScopedWriteCarveout(userMessage)) return [...prohibitions];
  const withoutCarveout = userMessage.replace(SCOPED_WRITE_CARVEOUT, " ");
  if (hasIndependentWorkspaceWriteCue(withoutCarveout)) return [...prohibitions];
  return prohibitions.filter((c) => c !== "workspace-write");
}

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
  for (const re of READ_FIRST_CUES) collect(re);

  const strong: ConfirmedConstraints = { prohibitions: [], obligations: [] };
  for (const { re, cls } of STRONG_PROHIBITIONS) {
    if (re.test(userMessage) && !strong.prohibitions.includes(cls)) strong.prohibitions.push(cls);
    re.lastIndex = 0; // /g regex reused via .test — reset between calls
  }
  // A partitive carve-out ("don't change any OTHER feature") is never a blanket
  // write ban — never let the strong (LLM-outage) tier over-block on one.
  strong.prohibitions = vetoScopedWrite(strong.prohibitions, userMessage);
  if (OBLIGATION_CUES.some((re) => userMessage.match(re) !== null)) {
    strong.obligations.push({ kind: "commit-when-done" });
  }
  if (READ_FIRST_CUES.some((re) => userMessage.match(re) !== null)) {
    strong.obligations.push({ kind: "read-before-answer" });
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

obligations — allowed values only:
- "commit-when-done": the user asked to commit / check the work in when done.
- "read-before-answer": the user asked to read/consult a specific file or the repo BEFORE answering or deciding.

HIGH PRECISION RULES:
- Include a constraint ONLY when the user EXPLICITLY stated it as an instruction for THIS task.
- Narration ("I never run the tests"), questions, and negations about outcomes ("don't break the build") are NOT constraints.
- "I'll test/verify/run/handle it myself" implies the agent should not do that step itself — map to the matching class.
- "workspace-write" means the user forbade editing files AT ALL (a diagnose/read-only session). A prohibition that only CARVES OUT a subset while the task itself asks for changes is NOT workspace-write — e.g. "remove X but don't change any OTHER feature", "fix the bug but don't touch the tests", "refactor auth but leave the public API alone". If the message asks you to edit/create/remove/rename/refactor anything, do NOT return workspace-write. Conversely, a genuine read-only session that ALSO contains a carve-out phrase ("read-only session, don't touch anything else") IS workspace-write — the carve-out doesn't cancel an explicit read-only instruction.
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
  const obligations: Obligation[] = [];
  if (obj.obligations.some((o) => o === "commit-when-done")) obligations.push({ kind: "commit-when-done" });
  if (obj.obligations.some((o) => o === "read-before-answer")) obligations.push({ kind: "read-before-answer" });
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
  // The carve-out veto applies ONLY to the deterministic tier (phraseGate
  // already vetoed gate.strong): a per-phrase regex can't tell a spurious
  // carve-out ban from a real one standing beside it. The LLM CAN — it saw the
  // full message, carve-out included, and SYSTEM_PROMPT explicitly weighs
  // partitive carve-outs — so a workspace-write it still returns is a verdict
  // that a REAL ban co-occurs ("read-only session, don't touch anything else").
  // Re-running the regex veto here would erase that verdict, silently dropping
  // a ban the user actually stated (the audited veto-override bug).
  const prohibitions = [...result.prohibitions];
  if (prohibitions.length === 0 && result.obligations.length === 0) {
    return emptyLedger(); // confirm rejected the cues (or nothing was strong)
  }
  // Enrich a read-before-answer obligation with the file the user named, applied
  // deterministically to BOTH paths (LLM confirm returns the kind without a
  // target; the strong tier likewise) so the audit can require THAT file was
  // read, not just any read.
  const readTarget = extractReadTarget(userMessage);
  const obligations = result.obligations.map((o) =>
    o.kind === "read-before-answer" && readTarget ? { kind: "read-before-answer" as const, target: readTarget } : o,
  );
  return {
    prohibitions,
    obligations,
    phrases: gate.cues,
  };
}
