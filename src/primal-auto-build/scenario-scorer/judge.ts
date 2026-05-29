/**
 * Final-scoring LLM call: given a scenario + the driver's trace, return
 * a 0-10 satisfaction score with criteria-by-criteria reasoning.
 *
 * Distinct from the step-planner — the planner makes per-step driving
 * decisions, the judge makes ONE overall scoring call at the end. Reads
 * the scenario's "Pass criteria" as the rubric. The score isn't just
 * pass/fail because we want the option to auto-fix on near-misses
 * (score 5-6) and halt only on real misses (<5).
 *
 * Scoring rubric (encoded in the prompt):
 *   10: every step executed cleanly + every pass criterion met + no console/network errors
 *    8: every pass criterion met but some console errors or one warning-class step
 *    7: most criteria met; one minor failure that doesn't break the user flow
 *    5: half the criteria met; obvious bugs blocking the flow
 *    3: scenario can't complete; major UI/backend failure
 *    0: app didn't load or errored before step 1
 */

import { classifyWithLLM } from "../../classifiers/classify-with-llm.js";
import type { ParsedScenario, ScoreStep } from "./types.js";
import type { LlmCall } from "../chunk-review/judgment-hook.js";

const JUDGE_SYSTEM_PROMPT =
  `You are scoring a user-flow scenario against a built app. ` +
  `Follow the rubric in the user message exactly. ` +
  `Respond with ONE JSON line and nothing else — no prose, no code fences.`;

export interface JudgeInput {
  scenario: ParsedScenario;
  steps: ScoreStep[];
  finalUrl: string;
  /** Optional bytes — judge skips screenshot if too large for the model. */
  screenshotBase64?: string;
}

export interface JudgeResult {
  score: number;
  metCriteria: string[];
  failedCriteria: string[];
  reasoning: string;
}

const JUDGE_TIMEOUT_MS = 20_000;

export function buildJudgePrompt(input: JudgeInput): string {
  const stepsBlock = input.steps.map(s =>
    `  [${s.index}] ${s.status.toUpperCase()}: ${s.text}\n` +
    `      action: ${s.action}\n` +
    `      outcome: ${s.outcome}\n` +
    (s.consoleErrors.length ? `      console_errors: ${s.consoleErrors.slice(0, 3).join(" | ")}\n` : "") +
    (s.networkFailures.length ? `      network_failures: ${s.networkFailures.slice(0, 3).join(" | ")}\n` : ""),
  ).join("\n");

  return (
    `You are scoring a user-flow scenario against a built app. The driver has already executed ` +
    `each step; your job is to decide how well the app supports the scenario, 0-10.\n\n` +
    `## Scenario\n\n` +
    `Title: ${input.scenario.title}\n` +
    `Persona: ${input.scenario.persona}\n\n` +
    `Steps the persona walked through:\n${input.scenario.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n\n` +
    `Pass criteria:\n${input.scenario.passCriteria || "(none stated)"}\n\n` +
    `## Driver trace\n\n` +
    `Final URL: ${input.finalUrl}\n\n` +
    `Step-by-step:\n${stepsBlock}\n\n` +
    `## Score rubric (be honest, not generous)\n\n` +
    `  10 — every step ran cleanly, every pass criterion met, zero console/network errors\n` +
    `   8 — every pass criterion met but some console errors or one warning-class step\n` +
    `   7 — most criteria met; one minor failure that doesn't break the user flow\n` +
    `   5 — half the criteria met; obvious bugs blocking the flow\n` +
    `   3 — scenario can't complete; major UI/backend failure\n` +
    `   0 — app didn't load or errored before step 1\n\n` +
    `Return ONE JSON line, nothing else:\n` +
    `{"score": <0-10 integer>,\n` +
    ` "met_criteria": ["<each pass criterion the flow met, verbatim or paraphrased>"],\n` +
    ` "failed_criteria": ["<each pass criterion the flow failed, verbatim or paraphrased>"],\n` +
    ` "reasoning": "<2-3 sentence explanation of why this score, citing specific steps and observations>"}`
  );
}

export function parseJudgeResponse(raw: string): JudgeResult | null {
  const m = raw.trim().match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as Partial<JudgeResult>;
    const score = Number(parsed.score);
    if (!Number.isFinite(score) || score < 0 || score > 10) return null;
    return {
      score: Math.round(score),
      metCriteria: Array.isArray(parsed.metCriteria) ? parsed.metCriteria.map(String) :
                   Array.isArray((parsed as Record<string, unknown>).met_criteria) ? ((parsed as Record<string, unknown>).met_criteria as unknown[]).map(String) : [],
      failedCriteria: Array.isArray(parsed.failedCriteria) ? parsed.failedCriteria.map(String) :
                      Array.isArray((parsed as Record<string, unknown>).failed_criteria) ? ((parsed as Record<string, unknown>).failed_criteria as unknown[]).map(String) : [],
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    return null;
  }
}

let injectedLlmCall: LlmCall | null = null;
export function _setLlmCallForTests(fn: LlmCall | null): void { injectedLlmCall = fn; }

export async function judgeScenario(input: JudgeInput, signal?: AbortSignal): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(input);

  // Test injection path — keeps deterministic stubs working without a real provider.
  if (injectedLlmCall) {
    const SENTINEL = Symbol("judge-timeout");
    const wallclock = new Promise<typeof SENTINEL>((r) => setTimeout(() => r(SENTINEL), JUDGE_TIMEOUT_MS));
    const raced = await Promise.race([injectedLlmCall(prompt, signal).catch(() => ""), wallclock]);
    if (raced === SENTINEL) throw new Error("judge timeout");
    const result = parseJudgeResponse(String(raced || ""));
    if (!result) throw new Error("judge returned unparseable response");
    return result;
  }

  const result = await classifyWithLLM<JudgeResult>({
    category: "scenario-judge",
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    userPrompt: prompt,
    parse: parseJudgeResponse,
    timeoutMs: JUDGE_TIMEOUT_MS,
    maxResponseChars: 4000,
    signal,
  });
  if (!result) throw new Error("judge returned unparseable response");
  return result;
}
