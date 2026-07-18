import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";

export interface ActionEntry {
  opId?: string;
  sessionId: string;
  type: string;
  details: string;
  timestamp: number;
  outcome?: "clean" | "partial" | "aborted";
  category?: "browser" | "computer" | "coding" | "connector" | "research" | "general";
  tools?: string[];
  model?: string;
}

export interface OutcomeEvidence {
  opId: string;
  sessionId: string;
  outcome: NonNullable<ActionEntry["outcome"]>;
  category: NonNullable<ActionEntry["category"]>;
  tools: string[];
  model?: string;
  timestamp: number;
}

export interface DetectedPattern {
  type: "question" | "task" | "topic" | "time" | "workflow";
  description: string;
  occurrences: number;
  lastSeen: number;
  examples: string[];
  suggestedAction?: string;
  automationEligible?: boolean;
  outcomeStats?: {
    clean: number;
    partial: number;
    aborted: number;
    successRate: number;
    weightedSuccessRate: number;
    distinctSessions: number;
  };
}

export interface AutomationSuggestion {
  type: "mission" | "cron" | "shortcut";
  name: string;
  description: string;
  config: Record<string, unknown>;
}

export type LearnedCandidateState =
  | "candidate"
  | "approved"
  | "active"
  | "rejected"
  | "archived"
  | "rolled-back";

export interface CandidateEvidenceSnapshot {
  patternType: DetectedPattern["type"];
  description: string;
  occurrences: number;
  lastSeen: number;
  examples: string[];
  outcomeStats?: NonNullable<DetectedPattern["outcomeStats"]>;
}

export interface CandidateTransition {
  from: LearnedCandidateState;
  to: LearnedCandidateState;
  timestamp: number;
  reason?: string;
}

export interface LearnedCandidate {
  id: string;
  state: LearnedCandidateState;
  confidence: number;
  suggestion: AutomationSuggestion;
  evidence: CandidateEvidenceSnapshot;
  createdAt: number;
  updatedAt: number;
  rejectionCooldownUntil?: number;
  transitions: CandidateTransition[];
}

export interface SessionInsight {
  type: string;
  description: string;
  data: unknown;
  period: "daily" | "weekly" | "monthly";
}

// Type alias (not interface) so it satisfies json-store's Record constraint.
export type SessionData = {
  actions: ActionEntry[];
  candidates: LearnedCandidate[];
  lastPrune: number;
};

export const LAX_DIR = getLaxDir();
export const DATA_FILE = join(LAX_DIR, "cross-session-data.json");
export const MAX_ACTIONS = 5000;
export const DEFAULT_MIN_OCCURRENCES = 3;
export const PRUNE_AGE_DAYS = 30;
export const REJECTION_COOLDOWN_DAYS = 30;
export const MS_PER_DAY = 86400000;

export const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "about", "that",
  "this", "it", "its", "and", "or", "but", "not", "if", "then", "so",
  "what", "how", "when", "where", "who", "which", "there", "here",
  "i", "me", "my", "you", "your", "we", "our", "they", "them", "their",
]);
