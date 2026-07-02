/**
 * Per-step LLM call: given a scenario step + a page snapshot, decide
 * what Playwright action to take. Keeps the LLM focused on *one* tiny
 * decision per call so the prompt stays small and the response stays
 * structured.
 *
 * Reuses the same provider routing as the judgment-hook (active chat
 * provider, same auth path). Like the judgment-hook, this is a
 * higher-order function over the LLM call so tests can stub it.
 *
 * Why not let Playwright auto-resolve via getByRole/getByText alone? It
 * works for happy paths ("click the Continue button") but fails on
 * ambiguous steps ("schedules an appointment for Biscuit, Friday 10am")
 * where the LLM has to map natural language to a concrete selector +
 * value. The planner threads that needle without delegating the whole
 * scenario to a freewheeling agent (which is what Day 3 explicitly does NOT).
 */

import { classifyWithLLM } from "../../classifiers/classify-with-llm.js";
import type { LlmCall } from "../chunk-review/judgment-hook.js";

const STEP_PLANNER_SYSTEM_PROMPT =
  `You are translating ONE scenario step into ONE Playwright action. ` +
  `Follow the locator and action-choice rules in the user message exactly. ` +
  `Respond with ONE JSON line and nothing else — no prose, no code fences.`;

export type StepAction = "click" | "fill" | "navigate" | "assert-text" | "skip";

export interface StepActionPlan {
  action: StepAction;
  /** Playwright selector. For "navigate", null. For "assert-text", null. */
  selector?: string | null;
  /** For fill/navigate/assert-text — the value to type, URL, or text to assert. */
  value?: string | null;
  /** When action="skip" — why. */
  reason?: string;
  /** Confidence the LLM expressed (0-1). Currently informational. */
  confidence?: number;
}

interface ChooseStepActionInput {
  stepText: string;
  snapshot: string;
  scenarioContext: string;
  stepNumber: number;
}

const STEP_PLANNER_TIMEOUT_MS = 10_000;

export function buildStepPlannerPrompt(input: ChooseStepActionInput): string {
  return (
    `You are translating ONE scenario step into ONE Playwright action.\n\n` +
    `Scenario: ${input.scenarioContext}\n` +
    `Step ${input.stepNumber}: ${input.stepText}\n\n` +
    `Current page snapshot:\n${input.snapshot}\n\n` +
    `Pick an action and return ONE JSON line, nothing else:\n` +
    `  {"action": "click" | "fill" | "navigate" | "assert-text" | "skip",\n` +
    `   "selector": "<Playwright locator string, or null>",\n` +
    `   "value": "<text to fill OR url OR text to assert OR null>",\n` +
    `   "reason": "<one short phrase>",\n` +
    `   "confidence": 0.0..1.0}\n\n` +
    `Locator guidance: prefer semantic locators —\n` +
    `  - role+name: \`role=button[name=/Continue/i]\`\n` +
    `  - text:      \`text=Sign up with email\`\n` +
    `  - label:     \`input[name="email"]\` or \`label=Email\`\n` +
    `  - data-testid: \`[data-testid="signup-submit"]\`\n` +
    `Fall back to CSS only when nothing semantic fits.\n\n` +
    `Action choice rules:\n` +
    `  - click  → button, link, or option the step says to interact with\n` +
    `  - fill   → form field; value is what to type (use scenario context for values like "Maria Lopez")\n` +
    `  - navigate → only when the step says to load a different URL\n` +
    `  - assert-text → step is checking a UI condition (e.g. "Verifies the change saved")\n` +
    `  - skip   → step describes thinking, decisions, or actions outside the browser (e.g. "Skips Stripe Connect (will set up tomorrow)")\n\n` +
    `Be ruthlessly literal. If the step is ambiguous, prefer skip with reason over guessing.`
  );
}

export function parseStepPlannerResponse(raw: string): StepActionPlan | null {
  const trimmed = raw.trim();
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as Partial<StepActionPlan>;
    const action = parsed.action;
    if (action !== "click" && action !== "fill" && action !== "navigate" && action !== "assert-text" && action !== "skip") {
      return null;
    }
    return {
      action,
      selector: typeof parsed.selector === "string" ? parsed.selector : null,
      value: typeof parsed.value === "string" ? parsed.value : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
    };
  } catch {
    return null;
  }
}

let injectedLlmCall: LlmCall | null = null;
export function _setLlmCallForTests(fn: LlmCall | null): void { injectedLlmCall = fn; }

export async function chooseStepAction(input: ChooseStepActionInput): Promise<StepActionPlan> {
  const prompt = buildStepPlannerPrompt(input);

  if (injectedLlmCall) {
    const SENTINEL = Symbol("step-planner-timeout");
    const wallclock = new Promise<typeof SENTINEL>((r) => setTimeout(() => r(SENTINEL), STEP_PLANNER_TIMEOUT_MS));
    const raced = await Promise.race([injectedLlmCall(prompt).catch(() => ""), wallclock]);
    if (raced === SENTINEL) throw new Error("step planner timeout");
    const plan = parseStepPlannerResponse(String(raced || ""));
    if (!plan) throw new Error("step planner returned unparseable response");
    return plan;
  }

  const plan = await classifyWithLLM<StepActionPlan>({
    category: "scenario-step-planner",
    systemPrompt: STEP_PLANNER_SYSTEM_PROMPT,
    userPrompt: prompt,
    parse: parseStepPlannerResponse,
    timeoutMs: STEP_PLANNER_TIMEOUT_MS,
    maxResponseChars: 2000,
  });
  if (!plan) throw new Error("step planner returned unparseable response");
  return plan;
}
