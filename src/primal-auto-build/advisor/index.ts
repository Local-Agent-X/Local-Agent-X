/**
 * LLM advisor — the "orchestrator-as-agent" decision layer.
 *
 * Lives ABOVE the mechanical gates and the scenario scorer. When the
 * loop hits a situation where multiple recoveries are plausible — a
 * scenario failed, a worker push-backed, three halts share a gate — the
 * loop consults the advisor with the full context (failures, spec,
 * constitution, recent history) and the advisor returns ONE structured
 * recommendation: try-fix-worker | amend-spec-additively | halt.
 *
 * Why an advisor instead of expanding the mechanical gates? Mechanical
 * gates handle deterministic cases (test failures, weakened spec).
 * Recovery decisions for fuzzy cases ("the booking page fails because
 * the date format is wrong AND the spec doesn't actually pin a format")
 * require judgment over a body of text. That's an LLM call.
 *
 * Spec-safety contract: the advisor CAN recommend "amend-spec-additively"
 * with a concrete additive constraint text. The existing additive-diff
 * gate is the backstop — if the advisor's amendment weakens spec, the
 * gate halts. Defense in depth.
 *
 * Failure mode: any error (no provider, timeout, unparseable response)
 * returns null → caller falls back to the existing deterministic path
 * (one fix-worker attempt, then halt). Never blocks the build.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ParsedChunk } from "../plan-parser.js";
import type { ScoreReport } from "../scenario-scorer/types.js";
import type { LlmCall } from "../chunk-review/judgment-hook.js";

const ADVISOR_TIMEOUT_MS = 18_000;

export type AdvisorAction =
  | "try-fix-worker"
  | "amend-spec-additively"
  | "halt";

export interface AdvisorRecommendation {
  action: AdvisorAction;
  /** Extra context the loop should pass to the fix-worker when action === try-fix-worker. */
  fixWorkerHint?: string;
  /** Additive constraint text when action === amend-spec-additively. */
  specAddition?: string;
  /** One-sentence reasoning, surfaced to the user. */
  reasoning: string;
  /** Halt explanation when action === halt. */
  haltReason?: string;
}

export interface PhaseGateFailureSituation {
  kind: "phase-gate-scenario-failure";
  chunk: ParsedChunk;
  failedReports: ScoreReport[];
  passedReports: ScoreReport[];
  projectDir: string;
  /** Whether this is the first or second attempt at recovery for this gate. */
  attemptNumber: 1 | 2;
}

export type AdvisorSituation = PhaseGateFailureSituation;

export interface AdvisorOptions {
  llmCall?: LlmCall;
  signal?: AbortSignal;
}

/**
 * Ask the advisor what to do. Returns null on any failure — caller is
 * responsible for the fall-back path.
 */
export async function consultAdvisor(situation: AdvisorSituation, opts: AdvisorOptions = {}): Promise<AdvisorRecommendation | null> {
  const call = opts.llmCall || (await getProductionLlmCall());
  const prompt = buildAdvisorPrompt(situation);

  let raw: string;
  try {
    raw = await callWithTimeout(call, prompt, opts.signal, ADVISOR_TIMEOUT_MS);
  } catch {
    return null;
  }
  return parseAdvisorResponse(raw);
}

// ── prompt construction ────────────────────────────────────────────────────

export function buildAdvisorPrompt(situation: AdvisorSituation): string {
  const constitution = readConstitution(situation.projectDir);
  const failureBlock = situation.failedReports.map(r =>
    `- ${r.scenarioTitle} — score ${r.score}/10\n  reasoning: ${r.reasoning}\n  failed criteria: ${r.failedCriteria.join("; ") || "(none enumerated)"}`,
  ).join("\n");
  const passingBlock = situation.passedReports.map(r => `- ${r.scenarioTitle} (${r.score}/10)`).join("\n") || "(none)";

  return (
    `You are advising a build orchestrator on how to recover from scenario-test failures at a ` +
    `phase-verification gate. The build paused; your job is to pick ONE recovery action.\n\n` +
    `## Situation\n\n` +
    `Chunk that closed the phase: chunk ${situation.chunk.number} — ${situation.chunk.title}\n` +
    `Phase: ${situation.chunk.phase}\n` +
    `Recovery attempt: ${situation.attemptNumber}\n\n` +
    `## Failing scenarios\n\n${failureBlock}\n\n` +
    `## Passing scenarios (do not regress these)\n\n${passingBlock}\n\n` +
    `## Project constitution (load-bearing rules)\n\n${constitution || "(no constitution file found)"}\n\n` +
    `## Recovery options\n\n` +
    `- **try-fix-worker** — spawn a fix-worker subprocess with the failure details. Pick this when ` +
    `the failure is clearly a code bug (selector wrong, format off, missing route) and the spec is ` +
    `correct. Provide a one-paragraph fixWorkerHint focusing the worker on the specific gap.\n` +
    `- **amend-spec-additively** — the spec is missing a constraint that, if encoded, would catch ` +
    `this class of failure. Provide a specAddition that ADDS a constraint without weakening any ` +
    `existing rule. The additive-diff gate will reject non-additive edits.\n` +
    `- **halt** — the failure is ambiguous, requires a design decision, or attempt 2 already failed. ` +
    `Provide a haltReason listing what the human needs to decide.\n\n` +
    `## Hard rules\n\n` +
    `1. You CANNOT weaken the constitution to make a scenario pass.\n` +
    `2. You CANNOT propose deleting or relaxing existing spec constraints.\n` +
    `3. On attempt 2, prefer halt unless you have HIGH confidence a different fix path works.\n\n` +
    `Reply with ONE JSON line, nothing else:\n` +
    `{"action": "try-fix-worker" | "amend-spec-additively" | "halt",\n` +
    ` "reasoning": "<one sentence>",\n` +
    ` "fixWorkerHint": "<one paragraph when try-fix-worker, else empty>",\n` +
    ` "specAddition": "<additive constraint text when amend-spec-additively, else empty>",\n` +
    ` "haltReason": "<halt context when halt, else empty>"}`
  );
}

export function parseAdvisorResponse(raw: string): AdvisorRecommendation | null {
  const m = raw.trim().match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as Partial<AdvisorRecommendation>;
    const action = parsed.action;
    if (action !== "try-fix-worker" && action !== "amend-spec-additively" && action !== "halt") return null;
    const reasoning = String(parsed.reasoning || "").trim();
    if (!reasoning) return null;

    if (action === "try-fix-worker") {
      const hint = String(parsed.fixWorkerHint || "").trim();
      return { action, reasoning, fixWorkerHint: hint };
    }
    if (action === "amend-spec-additively") {
      const addition = String(parsed.specAddition || "").trim();
      if (!addition) return null;
      return { action, reasoning, specAddition: addition };
    }
    return { action: "halt", reasoning, haltReason: String(parsed.haltReason || reasoning) };
  } catch {
    return null;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function readConstitution(projectDir: string): string {
  for (const rel of ["spec/constitution.md", "spec/CONSTITUTION.md", "CONSTITUTION.md"]) {
    const p = join(projectDir, rel);
    if (!existsSync(p)) continue;
    try {
      return readFileSync(p, "utf-8").slice(0, 6000);
    } catch { /* try next */ }
  }
  return "";
}

async function callWithTimeout(fn: LlmCall, prompt: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<string> {
  const SENTINEL = Symbol("advisor-timeout");
  const wallclock = new Promise<typeof SENTINEL>((r) => setTimeout(() => r(SENTINEL), timeoutMs));
  const call = fn(prompt, signal).catch(() => "");
  const winner = await Promise.race([call, wallclock]);
  if (winner === SENTINEL) throw new Error("advisor timeout");
  return String(winner || "");
}

async function getProductionLlmCall(): Promise<LlmCall> {
  return async (prompt: string, signal?: AbortSignal): Promise<string> => {
    const { getRuntimeConfig } = await import("../../config.js");
    const { SecretsStore } = await import("../../secrets.js");
    const { resolveProvider } = await import("../../agent-request.js");
    const { homedir } = await import("node:os");
    const runtime = getRuntimeConfig();
    const dataDir = join(homedir(), ".lax");
    const secretsStore = new SecretsStore(dataDir);
    const resolved = await resolveProvider(runtime, secretsStore, dataDir);
    if (!resolved.apiKey) throw new Error("no api key for advisor");
    if (resolved.provider === "anthropic") {
      const { streamForResponse_anthropic } = await import("../../memory/curate-classifier.js");
      return (await streamForResponse_anthropic(resolved.apiKey, resolved.model, prompt, signal)) || "";
    }
    if (resolved.provider === "codex" || resolved.provider === "openai") {
      const { streamForResponse_codex } = await import("../../memory/curate-classifier.js");
      return (await streamForResponse_codex(resolved.apiKey, resolved.model, prompt, signal)) || "";
    }
    throw new Error(`unsupported provider: ${resolved.provider}`);
  };
}
