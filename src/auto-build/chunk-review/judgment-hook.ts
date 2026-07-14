/**
 * LLM judgment hook — fires when the mechanical gates return "proceed"
 * but a Bookwell chunk-12-style implicit-spec violation might still
 * be present. The hook reads the project's constitution (if any), the
 * chunk's CHANGED file contents, and the agent's NOTE, then asks the
 * model: "does this implementation likely violate any rule? If yes,
 * what additive constraint should the spec gain?"
 *
 * Failure modes (all return null = no violation found = mechanical
 * verdict stands):
 *   - constitution file missing → run anyway with empty constitution
 *   - no CHANGED files → return null (no implementation to judge)
 *   - LLM call timeout / network error → return null
 *   - response not parseable JSON → return null
 *   - model says "no violation" → return null
 *
 * The hook is a higher-order function over the LLM call, so tests can
 * inject a stub without spawning a real provider request. The default
 * production hook wires the stub to LAX's classifier pattern (same
 * provider+model as the active chat — no Haiku hardcode).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { classifySchema } from "../../classifiers/schema-output.js";
import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReport } from "./report-parser.js";

const MAX_CONSTITUTION_CHARS = 6000;
const MAX_CHANGED_FILES = 12;
const MAX_FILE_CHARS = 3000;
const CLASSIFIER_TIMEOUT_MS = 12_000;

const JUDGMENT_SYSTEM_PROMPT =
  `You are auditing one build chunk for an implicit-spec violation. ` +
  `Follow the decision rules in the user message exactly. Bias STRONGLY toward null (no violation). ` +
  `Respond with ONE JSON line and nothing else — no prose, no code fences.`;

export interface JudgmentHookInput {
  chunk: ParsedChunk;
  report: ChunkReport;
  /** Absolute path to the project's working directory — used to read constitution + CHANGED files. */
  projectDir: string;
  signal?: AbortSignal;
}

export interface JudgmentResult {
  /** Additive constraint to append to spec/build-state.md as the amend_spec body. */
  specGap: string;
  /** Short reason for surfacing in event logs. */
  reasoning: string;
}

export type JudgmentHook = (input: JudgmentHookInput) => Promise<JudgmentResult | null>;

/** Function the hook calls to actually run the LLM query. Injectable for tests. */
export type LlmCall = (prompt: string, signal?: AbortSignal) => Promise<string>;

/**
 * Build a judgment hook around an injectable LLM call. Production code
 * uses {@link defaultJudgmentHook}; tests construct one with a stub
 * llmCall to control the model's response exactly.
 */
export function createLlmJudgmentHook(llmCall: LlmCall): JudgmentHook {
  return async (input) => {
    if (input.report.changed.length === 0) return null;

    const constitution = readConstitution(input.projectDir);
    const changedSnippets = readChangedFiles(input.projectDir, input.report.changed);

    if (!constitution && !changedSnippets.trim()) return null;

    const prompt = buildJudgmentPrompt({
      chunk: input.chunk,
      report: input.report,
      constitution,
      changedSnippets,
    });

    let raw: string;
    try {
      raw = await callWithTimeout(llmCall, prompt, input.signal, CLASSIFIER_TIMEOUT_MS);
    } catch {
      return null; // fail open
    }

    return parseJudgmentResponse(raw);
  };
}

/**
 * Default production hook — routes through the canonical classifier wrapper
 * (same provider+model as the active chat, single source of truth for
 * timeout/abort/provider-dispatch). Tests construct their own hook via
 * {@link createLlmJudgmentHook} with a stub LlmCall.
 */
export const defaultJudgmentHook: JudgmentHook = async (input) => {
  if (input.report.changed.length === 0) return null;
  const constitution = readConstitution(input.projectDir);
  const changedSnippets = readChangedFiles(input.projectDir, input.report.changed);
  if (!constitution && !changedSnippets.trim()) return null;

  const prompt = buildJudgmentPrompt({
    chunk: input.chunk,
    report: input.report,
    constitution,
    changedSnippets,
  });

  const result = await classifySchema<JudgmentEnvelope>({
    category: "chunk-review-judgment",
    systemPrompt: JUDGMENT_SYSTEM_PROMPT,
    userPrompt: prompt,
    schema: judgmentEnvelopeSchema,
    shapeHint: JUDGMENT_SHAPE_HINT,
    timeoutMs: CLASSIFIER_TIMEOUT_MS,
    maxResponseChars: 3000,
    signal: input.signal,
  });
  return result ? result.judgment : null; // null result = unavailable/unparseable → fail open
};

// ── prompt construction ───────────────────────────────────────────────────

interface PromptInput {
  chunk: ParsedChunk;
  report: ChunkReport;
  constitution: string;
  changedSnippets: string;
}

export function buildJudgmentPrompt(input: PromptInput): string {
  const { chunk, report, constitution, changedSnippets } = input;
  return (
    `You are auditing one build chunk for an implicit-spec violation. The mechanical gates ` +
    `(test failures, additive-diff, phase-gates) passed. Your only job: decide whether the ` +
    `code that landed silently violates a rule stated in the constitution but not yet stated ` +
    `as a chunk-local done-when criterion.\n\n` +

    `## Chunk\n\n` +
    `Title: ${chunk.title}\n` +
    `Class: ${chunk.klass}\n` +
    `Slice: ${chunk.slice}\n` +
    `Done when: ${chunk.doneWhen}\n\n` +

    `## Agent's NOTE\n\n${report.note || "(empty)"}\n\n` +

    `## Constitution\n\n${constitution || "(no constitution file found)"}\n\n` +

    `## CHANGED file snippets (truncated)\n\n${changedSnippets || "(no CHANGED files readable)"}\n\n` +

    `## Decision\n\n` +
    `Look for **implicit-spec violations** — patterns the constitution forbids that the code ` +
    `nevertheless implements, where the chunk's done-when didn't explicitly name the rule. ` +
    `Examples from prior builds:\n\n` +
    `- Constitution says "no silent failures affecting the user." Code renders a public ` +
    `  surface that consumes data with possible degraded/stale state. The code shows the ` +
    `  data without any visible "this may be stale" notice → VIOLATION. Spec should gain a ` +
    `  rule requiring the stale-data notice on degraded connections.\n` +
    `- Constitution says "validated server actions never receive raw user input." Code ` +
    `  introduces an action that takes a free-form string and trusts it → VIOLATION.\n\n` +

    `Bias STRONGLY toward null (no violation). False positives churn the spec and frustrate ` +
    `the build loop. Only fire when you can name (a) the specific constitution rule, AND ` +
    `(b) the specific code pattern that violates it, AND (c) a concrete additive constraint ` +
    `that would prevent the violation. If any of those three is fuzzy, return null.\n\n` +

    `Reply with ONE JSON line, nothing else:\n` +
    `{"violation": true|false, "rule": "<which constitution rule>", "pattern": "<code pattern>", "specGap": "<additive constraint text, ready to paste into spec>", "reasoning": "<one sentence>"}\n\n` +
    `When violation:false, set rule/pattern/specGap to empty strings.`
  );
}

const JUDGMENT_SHAPE_HINT =
  `{"violation": false, "rule": "", "pattern": "", "specGap": "", "reasoning": ""}`;

/**
 * "violation": false (or a violation with no usable specGap) is a VALID
 * reply meaning "no violation found" — not a parse failure, so it must not
 * burn classifySchema's self-correction retry. The schema therefore always
 * validates and carries the verdict inside an envelope; `judgment: null`
 * means "mechanical verdict stands". (classifySchema forbids nullable ROOT
 * schemas — a valid null would be indistinguishable from its failure path.)
 *
 * Honest delta vs the pre-schema parser: a malformed reply now gets ONE
 * self-correction retry before the fail-open null, so the null can arrive
 * one LLM round-trip later than the old immediate fail-open, and the retry
 * can recover a violation verdict the old parser dropped. That direction is
 * acceptable here — a recovered violation is MORE enforcement, not a softer
 * eval (the scenario judge is deliberately one-shot for the opposite reason).
 */
interface JudgmentEnvelope {
  judgment: JudgmentResult | null;
}

export const judgmentEnvelopeSchema = z
  .record(z.unknown())
  .transform((rec): JudgmentEnvelope => {
    if (rec.violation !== true) return { judgment: null };
    const specGap = String(rec.specGap || "").trim();
    if (!specGap) return { judgment: null };
    const reasoning = `Implicit spec violation: ${rec.rule || "(unnamed rule)"} — ${rec.reasoning || "(no reasoning)"}`;
    return { judgment: { specGap, reasoning } };
  });

export function parseJudgmentResponse(raw: string): JudgmentResult | null {
  const match = raw.trim().match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const result = judgmentEnvelopeSchema.safeParse(obj);
  return result.success ? result.data.judgment : null;
}

// ── filesystem reads (best-effort) ────────────────────────────────────────

function readConstitution(projectDir: string): string {
  const candidates = ["spec/constitution.md", "spec/CONSTITUTION.md", "CONSTITUTION.md"];
  for (const rel of candidates) {
    const p = join(projectDir, rel);
    if (!existsSync(p)) continue;
    try {
      const body = readFileSync(p, "utf-8");
      return body.slice(0, MAX_CONSTITUTION_CHARS);
    } catch { /* try next */ }
  }
  return "";
}

function readChangedFiles(projectDir: string, changed: string[]): string {
  const out: string[] = [];
  const files = changed.slice(0, MAX_CHANGED_FILES);
  for (const rel of files) {
    const abs = isAbsolute(rel) ? rel : resolve(projectDir, rel);
    if (!existsSync(abs)) continue;
    try {
      const s = statSync(abs);
      if (!s.isFile()) continue;
      const body = readFileSync(abs, "utf-8").slice(0, MAX_FILE_CHARS);
      out.push(`### ${rel}\n\n\`\`\`\n${body}\n\`\`\``);
    } catch { /* skip */ }
  }
  return out.join("\n\n");
}

// ── timeout race ──────────────────────────────────────────────────────────

async function callWithTimeout(
  fn: LlmCall,
  prompt: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  const SENTINEL = Symbol("judgment-timeout");
  const wallclock = new Promise<typeof SENTINEL>((r) => setTimeout(() => r(SENTINEL), timeoutMs));
  const call = fn(prompt, signal).catch(() => "");
  const winner = await Promise.race([call, wallclock]);
  if (winner === SENTINEL) throw new Error("classifier timeout");
  return String(winner || "");
}
