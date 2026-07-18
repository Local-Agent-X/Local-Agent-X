import type {
  ActionEntry,
  AutomationSuggestion,
  DetectedPattern,
  OutcomeEvidence,
  SessionData,
  SessionInsight,
} from "./types.js";
import {
  DEFAULT_MIN_OCCURRENCES,
  MAX_ACTIONS,
  MS_PER_DAY,
  PRUNE_AGE_DAYS,
} from "./types.js";
import { autoPrune, ensureDir, loadData, persistData } from "./persistence.js";
import {
  detectRepeatedQuestions,
  detectRepeatedTasks,
  detectRepeatedTopics,
  detectTimePatterns,
  detectWorkflowPatterns,
} from "./detectors.js";
import { getInsights, suggestAutomation } from "./suggestions.js";
import { fuzzyMatch } from "./text-utils.js";
import type { ModuleSignal } from "../../orchestrator/types.js";

export class CrossSessionLearner {
  private static instance: CrossSessionLearner;
  private data: SessionData;

  private constructor() {
    ensureDir();
    this.data = loadData();
    if (autoPrune(this.data)) {
      persistData(this.data);
    }
  }

  static getInstance(): CrossSessionLearner {
    if (!CrossSessionLearner.instance) {
      CrossSessionLearner.instance = new CrossSessionLearner();
    }
    return CrossSessionLearner.instance;
  }

  recordAction(
    sessionId: string,
    action: { type: string; details: string; timestamp: number }
  ): void {
    this.data.actions.push({
      sessionId,
      type: action.type,
      details: action.details,
      timestamp: action.timestamp,
    });

    if (this.data.actions.length > MAX_ACTIONS) {
      this.data.actions = this.data.actions.slice(
        this.data.actions.length - MAX_ACTIONS
      );
    }

    persistData(this.data);
  }

  /** Record only the structural receipt of a completed operation. Tool names
   *  are safe capability identifiers; arguments and result text are excluded
   *  so learning cannot become a second transcript or sensitive-data store. */
  recordOutcome(evidence: OutcomeEvidence): void {
    const tools = evidence.tools.map((tool) => tool.trim()).filter(Boolean);
    const entry: ActionEntry = {
      opId: evidence.opId,
      sessionId: evidence.sessionId,
      type: "op_outcome",
      details: `${evidence.category}:${tools.join(" -> ") || "no-tools"}`,
      timestamp: evidence.timestamp,
      outcome: evidence.outcome,
      category: evidence.category,
      tools,
      ...(evidence.model ? { model: evidence.model } : {}),
    };
    const existing = this.data.actions.findIndex((action) => action.opId === evidence.opId);
    if (existing >= 0) this.data.actions[existing] = entry;
    else this.data.actions.push(entry);
    if (this.data.actions.length > MAX_ACTIONS) {
      this.data.actions = this.data.actions.slice(-MAX_ACTIONS);
    }
    persistData(this.data);
  }

  detectPatterns(minOccurrences?: number): DetectedPattern[] {
    const min = minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    const actions: ActionEntry[] = this.data.actions;
    const patterns: DetectedPattern[] = [];

    patterns.push(...detectRepeatedQuestions(actions, min));
    patterns.push(...detectRepeatedTasks(actions, min));
    patterns.push(...detectRepeatedTopics(actions, Math.max(min, 5)));
    patterns.push(...detectTimePatterns(actions, min));
    patterns.push(...detectWorkflowPatterns(actions, min));

    return patterns.sort((a, b) => b.occurrences - a.occurrences);
  }

  suggestAutomation(pattern: DetectedPattern): AutomationSuggestion | null {
    if (pattern.automationEligible === false) return null;
    return suggestAutomation(pattern);
  }

  getInsights(): SessionInsight[] {
    return getInsights(this.data.actions);
  }

  fuzzyMatch(a: string, b: string): number {
    return fuzzyMatch(a, b);
  }

  /** Orchestrator signal: the most-recurring cross-session pattern, if any. */
  signalsFor(): ModuleSignal[] {
    const patterns = this.detectPatterns(3);
    // Only surface patterns with recent evidence — a frozen legacy data file
    // must never be injected as live user behavior.
    const staleCutoff = Date.now() - PRUNE_AGE_DAYS * MS_PER_DAY;
    const top = patterns.find((p) => p.lastSeen > staleCutoff);
    if (!top) return [];
    return [{ source: "cross-session-learning", signal: `Recurring pattern: ${top.description} (seen ${top.occurrences}x)`, priority: 3, category: "pattern", confidence: 1.0 }];
  }
}
