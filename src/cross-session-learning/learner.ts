import type {
  ActionEntry,
  AutomationSuggestion,
  DetectedPattern,
  SessionData,
  SessionInsight,
} from "./types.js";
import { DEFAULT_MIN_OCCURRENCES, MAX_ACTIONS } from "./types.js";
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

  suggestAutomation(pattern: DetectedPattern): AutomationSuggestion {
    return suggestAutomation(pattern);
  }

  getInsights(): SessionInsight[] {
    return getInsights(this.data.actions);
  }

  fuzzyMatch(a: string, b: string): number {
    return fuzzyMatch(a, b);
  }
}
