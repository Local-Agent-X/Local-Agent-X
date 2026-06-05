/**
 * Goal decomposer — LLM call that turns a user goal into an ordered phase plan.
 *
 * Input:  "build me a WooCommerce store for pmajlabs.com"
 * Output: [
 *   { name: "Domain setup", goal: "point pmajlabs.com DNS to hosting", ... },
 *   { name: "Provision hosting", goal: "WordPress instance running on WP Engine", ... },
 *   { name: "Install WooCommerce", ... },
 *   ...
 * ]
 *
 * Falls back to a single ad-hoc phase if no LLM is available — Operations is
 * still useful even without decomposition (just linear execution).
 */
import { randomBytes } from "node:crypto";
import { dispatch } from "../llm-dispatch.js";
import type { OperationPhase } from "./types.js";

export interface DecomposerOptions {
  provider?: "ollama" | "anthropic" | "openai" | "auto";
  model?: string;
  timeoutMs?: number;
  /** Names of protocols already installed — helps the decomposer map phases to them. */
  knownProtocols?: string[];
}

export interface DecompositionResult {
  summary: string;
  phases: OperationPhase[];
}

function phaseId(): string { return `ph_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`; }

/**
 * Decompose a goal into phases.
 * Returns a single ad-hoc phase if LLM fails — operation still runs, just less structured.
 */
export async function decomposeGoal(goal: string, opts: DecomposerOptions = {}): Promise<DecompositionResult> {
  const llmOutput = await callDecomposer(goal, opts);
  if (!llmOutput) {
    // Fallback: one phase, ad-hoc execution
    return {
      summary: `Ad-hoc execution (decomposer unavailable): ${goal.slice(0, 200)}`,
      phases: [{
        id: phaseId(),
        name: "Execute goal",
        goal,
        successCriteria: ["User confirms the goal is achieved"],
        suggestedTools: ["browser", "bash", "read", "write"],
        protocolName: null,
        status: "pending",
        attempts: 0,
      }],
    };
  }
  return parsePlan(llmOutput, goal);
}

function buildPrompt(goal: string, knownProtocols: string[]): string {
  const protoList = knownProtocols.length > 0
    ? `\n\nAvailable protocols (use by name when a phase matches one):\n${knownProtocols.map(p => `- ${p}`).join("\n")}\n`
    : "";

  return `You are a project planner. Break the user's goal into ordered phases that can be executed autonomously by an AI agent with browser, shell, and API tools.

USER GOAL:
${goal}
${protoList}
Rules:
- 3-8 phases. Fewer if the goal is simple.
- Each phase is SELF-CONTAINED and measurable ("DNS is pointing to host X", not "work on DNS").
- Order matters — phase N+1 should depend only on outputs of phases 1..N.
- Pick a protocol name ONLY if one listed above clearly matches. Otherwise null.
- List 2-5 tools the phase will likely need (browser, bash, http_request, write, edit, read, email_send, etc.)

Output ONLY a JSON object in this exact shape (no markdown fences, no prose):

{
  "summary": "one sentence restating the goal at a higher level",
  "phases": [
    {
      "name": "Short phase name",
      "goal": "What this phase must achieve, concretely",
      "successCriteria": ["verifiable thing 1", "verifiable thing 2"],
      "suggestedTools": ["browser", "http_request"],
      "protocolName": null
    }
  ]
}`;
}

function parsePlan(llmText: string, originalGoal: string): DecompositionResult {
  // Find the JSON blob — tolerate surrounding prose / markdown fences
  let jsonText = llmText.trim();
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) jsonText = fence[1].trim();
  // If LLM added prose before/after the object, carve out the first {...}
  const firstBrace = jsonText.indexOf("{");
  const lastBrace = jsonText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1);
  }

  let parsed: { summary?: string; phases?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { summary: originalGoal, phases: [fallbackPhase(originalGoal)] };
  }
  if (!parsed.phases || !Array.isArray(parsed.phases) || parsed.phases.length === 0) {
    return { summary: parsed.summary || originalGoal, phases: [fallbackPhase(originalGoal)] };
  }
  const phases: OperationPhase[] = parsed.phases.map((p) => ({
    id: phaseId(),
    name: String(p.name || "Unnamed phase").slice(0, 100),
    goal: String(p.goal || originalGoal).slice(0, 500),
    successCriteria: Array.isArray(p.successCriteria) ? (p.successCriteria as unknown[]).map(s => String(s).slice(0, 200)).slice(0, 8) : [],
    suggestedTools: Array.isArray(p.suggestedTools) ? (p.suggestedTools as unknown[]).map(s => String(s).slice(0, 50)).slice(0, 10) : [],
    protocolName: typeof p.protocolName === "string" ? p.protocolName : null,
    status: "pending",
    attempts: 0,
  }));
  return { summary: String(parsed.summary || originalGoal).slice(0, 500), phases };
}

function fallbackPhase(goal: string): OperationPhase {
  return {
    id: phaseId(),
    name: "Execute goal",
    goal,
    successCriteria: ["User confirms the goal is achieved"],
    suggestedTools: ["browser", "bash", "read", "write"],
    protocolName: null,
    status: "pending",
    attempts: 0,
  };
}

// Decomposer rejects Anthropic OAuth (a CLI subscription can't serve bulk JSON
// planning); otherwise it runs on the user's configured provider, resolved
// store-aware by dispatch.
async function callDecomposer(goal: string, opts: DecomposerOptions): Promise<string | null> {
  return dispatch({
    prompt: buildPrompt(goal, opts.knownProtocols || []),
    provider: opts.provider,
    ollamaModel: opts.model || "llama3:8b",
    anthropicModel: opts.model,
    openaiModel: opts.model,
    temperature: 0.3,
    maxTokens: 1500,
    timeoutMs: opts.timeoutMs ?? 30_000,
    rejectOAuth: true,
  });
}
