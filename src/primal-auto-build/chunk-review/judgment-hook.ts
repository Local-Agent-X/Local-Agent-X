/**
 * LLM judgment hook — fires when the mechanical gates return "proceed"
 * but a Calenbella chunk-12-style implicit-spec violation might still
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
import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReport } from "./report-parser.js";

const MAX_CONSTITUTION_CHARS = 6000;
const MAX_CHANGED_FILES = 12;
const MAX_FILE_CHARS = 3000;
const CLASSIFIER_TIMEOUT_MS = 12_000;

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
 * Default production hook — wires the LLM call to LAX's classifier
 * pattern (same provider+model as the active chat). Imports are lazy
 * so unit tests that don't exercise the default hook never load the
 * provider modules.
 */
export const defaultJudgmentHook: JudgmentHook = createLlmJudgmentHook(async (prompt, signal) => {
  const { getRuntimeConfig } = await import("../../config.js");
  const { getOrInitSecretsStore } = await import("../../secrets.js");
  const { resolveProvider } = await import("../../agent-request/index.js");
  const { getLaxDir } = await import("../../lax-data-dir.js");

  const runtime = getRuntimeConfig();
  const dataDir = getLaxDir();
  const secretsStore = getOrInitSecretsStore(dataDir);
  const resolved = await resolveProvider(runtime, secretsStore, dataDir);
  if (!resolved.apiKey) throw new Error("no api key");

  if (resolved.provider === "anthropic") {
    const { streamForResponse_anthropic } = await import("../../memory/curate-classifier.js");
    return (await streamForResponse_anthropic(resolved.apiKey, resolved.model, prompt, signal)) || "";
  }
  if (resolved.provider === "codex" || resolved.provider === "openai") {
    const { streamForResponse_codex } = await import("../../memory/curate-classifier.js");
    return (await streamForResponse_codex(resolved.apiKey, resolved.model, prompt, signal)) || "";
  }
  throw new Error(`unsupported provider: ${resolved.provider}`);
});

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

export function parseJudgmentResponse(raw: string): JudgmentResult | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      violation?: boolean;
      rule?: string;
      pattern?: string;
      specGap?: string;
      reasoning?: string;
    };
    if (parsed.violation !== true) return null;
    const specGap = String(parsed.specGap || "").trim();
    if (!specGap) return null;
    const reasoning = `Implicit spec violation: ${parsed.rule || "(unnamed rule)"} — ${parsed.reasoning || "(no reasoning)"}`;
    return { specGap, reasoning };
  } catch {
    return null;
  }
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
