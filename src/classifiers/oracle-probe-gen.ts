/**
 * Oracle-probe generator (grok-lift pick #1, the flagship — generation half).
 *
 * The documented residual failure: a coding model ships code that compiles but is
 * behaviorally wrong, and its OWN self-tests share the same blind spot because it
 * wrote them while looking at its own implementation. The decorrelation lever is
 * CONTEXT control, not a smarter model: ask the SAME active model (Grok checks
 * Grok, Gemini checks Gemini — routed through the active provider via
 * classifyWithLLM) to write acceptance checks while it sees ONLY the task spec and
 * the file names — never the code, never its own tests. Fresh, spec-anchored
 * expectations catch what the implementation-shaped tests missed.
 *
 * This module ONLY generates the probe. Execution + the nudge gate live in the
 * spec-probe gate (turn-loop), so a probe is ground-truth (a real traceback), and
 * this fallible authorship stays advisory — a bad probe is discarded or rebutted,
 * never a hard block. Returns null on any failure (classifier unavailable, no
 * spec-anchored check derivable, unparseable) → the gate degrades to today.
 *
 * INVARIANTS-ONLY (measured 2026-07-02): a blind author can only assert what it
 * can DERIVE from the spec. Asserting a specific COMPUTED output it had to solve
 * for (a two-bucket move count, a poker ranking) false-reds CORRECT code — grok
 * blind-guessed `measure(3,5,1,"one")==(8,"one",3)` when the answer is
 * `(4,"one",5)` and nagged a correct solution. So the prompt permits only LITERAL
 * spec examples, spec-stated error paths, and STRUCTURAL INVARIANTS (type, length,
 * ordering, membership, round-trips, spec-named defining properties), and forbids
 * guessed computed values — abstaining (NONE) on search/optimization tasks.
 */

import { classifyWithLLM } from "./classify-with-llm.js";

export type ProbeLanguage = "python" | "node" | "shell";

export interface OracleProbe {
  language: ProbeLanguage;
  /** The executable probe body. Runnable as-is with the language's interpreter. */
  script: string;
}

/** Infer the probe interpreter from the edited file extensions. Defaults to shell
 *  (grep/run-the-binary checks) when no known source extension is present, so an
 *  arbitrary-language task still gets *some* spec-anchored check. */
export function probeLanguageFor(fileList: readonly string[]): ProbeLanguage {
  const ext = (p: string) => (p.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");
  const exts = fileList.map(ext);
  if (exts.includes("py")) return "python";
  if (exts.some((e) => ["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"].includes(e))) return "node";
  return "shell";
}

const INTERP_NOTE: Record<ProbeLanguage, string> = {
  python: "a Python 3 script (run with `python3 probe.py`); import the solution module by the name implied by the file list",
  node: "a Node.js script (run with `node probe.mjs`, ESM); import the solution by the path implied by the file list",
  shell: "a POSIX shell script (run with `sh probe.sh`); invoke the built artifact / CLI and assert on its output",
};

const SYSTEM_PROMPT = (language: ProbeLanguage) =>
  `You are writing an ACCEPTANCE TEST for a coding task, BEFORE and WITHOUT seeing the implementation. You are given ONLY the task specification and a list of file names — never the code. Your job is to encode the spec's REQUIREMENTS as executable checks so a wrong implementation fails loudly.

Write ${INTERP_NOTE[language]}.

CRITICAL — you did NOT solve this task and you cannot run the code, so assert ONLY facts you can establish from the spec text alone. Never guess. There are exactly two kinds of safe checks:

  1. LITERAL spec facts — a specific input→output the spec states VERBATIM (a worked example written in the description), and the exact exception TYPE / message the spec says to raise for a named bad input. Copy the values from the spec text; do not derive new ones.

  2. STRUCTURAL INVARIANTS — properties of the output that must hold WITHOUT computing the answer: return type/shape (returns a 3-tuple, a list, a string), length relationships (output length == input length; a transpose swaps row/column counts), membership (the result uses only characters/items from the input), ordering (the result is sorted), idempotence or round-trips (decode(encode(x)) == x), and any defining property the spec names — e.g. "the goal bucket ends holding exactly N liters" → assert THAT field equals N, WITHOUT asserting the move count you would have had to solve for.

FORBIDDEN: never assert a specific output VALUE you had to COMPUTE or SIMULATE yourself — a move/step count, a best-hand ranking, the numeric result of running a program, a search or optimization answer. If the spec does not literally print the expected value, you do not know it: assert an invariant about it instead, or omit the check. Guessing a computed value red-flags CORRECT code, which is worse than no check at all.

HARD RULES:
- Write the assertions at MODULE TOP LEVEL so they ALWAYS run when the file is executed. Do NOT wrap them in a function, class, or unittest/pytest framework — a test that is defined but never called exits 0 and proves nothing.
- Above each assertion put a SHORT comment (a few words) naming the spec rule or invariant it checks — not the full sentence. Do NOT reproduce the spec as a header/preamble block.
- The script must exit non-zero on a failed assertion and zero when all pass. Keep it self-contained and dependency-free (standard library only).
- Keep the ENTIRE script SHORT: at most ~40 lines. A few sharp, spec-grounded assertions beat many.
- If the spec gives no literal example and no checkable invariant, output EXACTLY the single word: NONE. Abstaining is correct and expected for search/optimization tasks — a wrong check is worse than none.
- Output ONLY the script (or NONE). No prose, no markdown fences, no explanation.`;

/**
 * Generate one implementation-blind acceptance probe from the task spec + file
 * list. Returns null when the classifier is unavailable, the model abstains
 * (NONE), or the output isn't a usable script — the gate then degrades to today's
 * behavior. Uses the ACTIVE provider (self-check) via classifyWithLLM, with a
 * raised response cap (a probe is longer than a yes/no) and a generous timeout (a
 * reasoning author needs it; the gate only fires at a done-claim where latency is
 * acceptable).
 */
export async function generateOracleProbe(input: {
  userRequest: string;
  fileList: readonly string[];
  /** The solution's public API — its `def`/`class`/export signature lines
   *  (bodies stripped). Task-mandated names, so handing them to the author
   *  keeps it blind to the LOGIC while ending wrong-API guesses (the dominant
   *  invalid class measured 2026-07-02: ModuleNotFound/AttributeError/TypeError
   *  from names the author invented off a bare file list). */
  apiSurface?: string;
  language?: ProbeLanguage;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<OracleProbe | null> {
  const spec = input.userRequest.trim();
  if (spec.length < 12) return null; // nothing to anchor a check to
  const language = input.language ?? probeLanguageFor(input.fileList);
  const files = input.fileList.length
    ? input.fileList.map((f) => `  - ${f}`).join("\n")
    : "  (none listed)";
  const api = input.apiSurface?.trim()
    ? `\n\nPUBLIC API SIGNATURES (call EXACTLY these names and arities — do not invent others):\n${input.apiSurface.trim()}`
    : "";

  const script = await classifyWithLLM<string>({
    category: "oracle-probe",
    systemPrompt: SYSTEM_PROMPT(language),
    userPrompt: `TASK SPECIFICATION:\n${spec}\n\nFILES IN THE WORKSPACE (names only — you may NOT see their contents):\n${files}${api}\n\nWrite the acceptance probe now.`,
    parse: (raw) => parseProbe(raw),
    // Headroom so a probe is never truncated mid-assertion (a cut-off script is a
    // SyntaxError → discarded as invalid → the gate silently does nothing). The
    // prompt already caps length to ~40 lines; this is the safety margin, and it
    // also drives classify-with-llm's server-side maxTokens for dispatch providers.
    maxResponseChars: 12_000,
    // The author is the ACTIVE (reasoning) model — probe QUALITY is the point,
    // and the gate only fires at a done-claim where latency is acceptable. The
    // background tier authored measurably worse probes (2026-07-02: guessed
    // computed values, wrong APIs). A reasoning tier needs the longer ceiling.
    modelTier: "active",
    timeoutMs: input.timeoutMs ?? 40_000,
    envDisableVar: "LAX_ORACLE_PROBES",
    signal: input.signal,
  });

  if (!script) return null;
  return { language, script };
}

/** Extract a usable probe body from the model's reply: strip an optional markdown
 *  fence, reject the NONE sentinel and anything with no assertion at all (a probe
 *  that can't fail is worthless and must not count as coverage). */
export function parseProbe(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  // Strip a single leading/trailing code fence if the model added one anyway.
  s = s.replace(/^```[a-z0-9]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  if (!s || /^NONE\b/i.test(s)) return null;
  // Must contain at least one assertion-shaped construct, else it proves nothing.
  if (!/\b(assert|raise|throw|exit\s*\(?\s*[1-9]|test\(|expect\(|\[\s*"?\$)/i.test(s) &&
      !/\bexit 1\b/.test(s)) return null;
  return s;
}
