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
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
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

// ── LLM plumbing (same shape as memory-resolver / memory-sleeptime / hyde) ──

async function callDecomposer(goal: string, opts: DecomposerOptions): Promise<string | null> {
  const timeout = opts.timeoutMs ?? 30_000;
  const provider = opts.provider === "auto" || !opts.provider ? detectProvider() : opts.provider;
  const prompt = buildPrompt(goal, opts.knownProtocols || []);

  if (provider === "ollama") return callOllama(prompt, opts.model || "llama3:8b", timeout);
  if (provider === "anthropic") return callAnthropic(prompt, opts.model || "claude-haiku-4-5-20251001", timeout);
  if (provider === "openai") return callOpenAI(prompt, opts.model || "gpt-4o-mini", timeout);
  return null;
}

function detectProvider(): "ollama" | "anthropic" | "openai" | null {
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.startsWith("sk-ant-api")) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "ollama";
}

async function callOllama(prompt: string, model: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.3, num_predict: 1200 } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json() as { response?: string };
    return data.response || null;
  } catch { return null; }
}

async function callAnthropic(prompt: string, model: string, timeoutMs: number): Promise<string | null> {
  try {
    let apiKey = process.env.ANTHROPIC_API_KEY || "";
    if (!apiKey) {
      try { apiKey = await (await import("../auth-anthropic.js")).getAnthropicApiKey(); } catch {}
    }
    if (!apiKey || !apiKey.startsWith("sk-ant-api")) return null; // decomposer needs real API, not CLI subscription
    const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 1500, temperature: 0.3, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text || null;
  } catch { return null; }
}

async function callOpenAI(prompt: string, model: string, timeoutMs: number): Promise<string | null> {
  try {
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) return null;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, temperature: 0.3, max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || null;
  } catch { return null; }
}
