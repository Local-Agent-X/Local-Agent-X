import { AnticipatoryCare } from "../anticipatory-care.js";
import type { OrchestratorInput, TriageResult } from "./types.js";
import { SENSITIVE_KEYWORDS, CORRECTION_KEYWORDS, FACT_PATTERNS, STORY_PATTERNS } from "./types.js";
import { safeRun } from "./state.js";

export function triageModules(input: OrchestratorInput, msgCount: number): TriageResult {
  const result: TriageResult = {
    always: ["emotional-memory", "language-mirror", "trust-engine"],
    conditional: [],
    scheduled: [],
    triggered: [],
  };

  const msg = input.message.toLowerCase();

  if (input.message.length < 60 || /^(that|this|the one|you know|it|same)\b/i.test(input.message)) {
    result.conditional.push("inside-references");
  }

  const care = safeRun("anticipatory-care", () => AnticipatoryCare.getInstance(), null);
  if (care) {
    const followUps = safeRun("anticipatory-care", () => care.getFollowUps(), []);
    if (followUps.length > 0) result.conditional.push("anticipatory-care");
    const proactive = safeRun("anticipatory-care", () => care.getProactiveMessage(input.timeOfDay), null);
    if (proactive) result.conditional.push("anticipatory-care");
  }

  if (SENSITIVE_KEYWORDS.some(kw => msg.includes(kw))) {
    result.conditional.push("vulnerability-awareness");
  }

  if (input.message.length > 30) {
    result.conditional.push("associative-recall");
  }

  result.conditional.push("proactive-memory");

  if (msgCount % 5 === 0) {
    result.conditional.push("cross-session-learning");
  }

  result.conditional.push("shared-history");

  if (msgCount % 10 === 0 && msgCount > 0) {
    result.scheduled.push("unspoken-detector");
  }

  if (msgCount % 20 === 0 && msgCount > 0) {
    result.scheduled.push("growth-tracker");
  }

  if (STORY_PATTERNS.some(p => p.test(input.message))) {
    result.scheduled.push("narrative-memory");
  }

  if (msgCount > 0 && (msgCount % 25 === 0 || msgCount === 1 || msgCount === 10 || msgCount === 50 || msgCount === 100)) {
    result.triggered.push("milestone-celebrations");
  }

  if (CORRECTION_KEYWORDS.some(kw => msg.includes(kw)) && input.agentPreviousMessage) {
    result.triggered.push("correction-learning");
  }

  if (FACT_PATTERNS.some(p => p.test(input.message))) {
    result.triggered.push("contradiction-detector");
  }

  if (input.message.length > 40) {
    result.conditional.push("memory-graph");
  }

  result.conditional = Array.from(new Set(result.conditional));
  result.scheduled = Array.from(new Set(result.scheduled));
  result.triggered = Array.from(new Set(result.triggered));

  return result;
}
