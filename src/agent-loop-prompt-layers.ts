// Per-attempt prompt layering.
//
// When a post-turn detector fires, its retry instruction needs to reach the
// model on the NEXT attempt. We do that by appending the instruction to the
// base system prompt for that attempt only — the base prompt stays
// untouched, and stale retry instructions don't leak into later attempts
// after the issue is resolved.
//
// Layering rules:
// - Instructions stack in priority order when multiple retries are active.
// - Each attempt reads the current instruction set; callers clear them when
//   the detector's condition no longer holds.
// - An "ack fast-path" instruction is a one-shot layer that gets set when
//   the user's latest message is a short approval ("ok", "do it", "go")
//   so the model skips recap and jumps to action.

import type { RetryInstruction } from "./agent-loop-detectors.js";

export interface PromptLayers {
  /** Most recent detector instruction (e.g. planning-only, empty-response) */
  retry?: RetryInstruction;
  /** User said "ok"/"do it"/"go" — skip plan recap */
  ackFastPath?: string;
}

export function createPromptLayers(): PromptLayers {
  return {};
}

/**
 * Build the effective system prompt for the next attempt by layering any
 * active retry/ack instructions on top of the base prompt.
 */
export function composeSystemPrompt(base: string, layers: PromptLayers): string {
  const additions: string[] = [];
  if (layers.ackFastPath) additions.push(layers.ackFastPath);
  if (layers.retry) additions.push(layers.retry.instruction);
  if (additions.length === 0) return base;
  return `${base}\n\n---\n${additions.join("\n\n")}`;
}

// ── Ack fast-path detection ────────────────────────────────────────────────
//
// Short approval phrases in the user's latest message. When detected, the
// model gets an instruction to skip the "here's the plan" recap and go
// straight to the first concrete tool action.

const ACK_NORMALIZED = new Set<string>([
  "ok", "okay", "ok do it", "okay do it", "do it",
  "go", "go ahead", "please do", "please", "yes",
  "yep", "yup", "yeah", "sure", "sounds good",
  "sounds good do it", "ship it", "ship", "fix it",
  "make it so", "yes do it", "yep do it", "continue",
  "keep going", "go on", "proceed", "do that",
  "now what", "ok now what", "next", "whats next",
]);

export const ACK_FAST_PATH_INSTRUCTION =
  "The user's latest message is a short approval/continuation ('ok', 'do it', 'continue', etc). Do not recap the plan. Do not restate prior steps. Take the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";

/** Detect if the user's latest message is just an ack. */
export function isAckMessage(userText: string): boolean {
  const normalized = userText.trim().toLowerCase().replace(/[.!?,;]+$/, "");
  if (!normalized) return false;
  if (normalized.length > 40) return false;
  if (ACK_NORMALIZED.has(normalized)) return true;
  // Tolerate tiny variations: "ok let's go", "yes do it please"
  const firstFewWords = normalized.split(/\s+/).slice(0, 3).join(" ");
  if (ACK_NORMALIZED.has(firstFewWords)) return true;
  return false;
}
