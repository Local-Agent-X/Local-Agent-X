import { join } from "node:path";
import { homedir } from "node:os";

export interface ActionEntry {
  sessionId: string;
  type: string;
  details: string;
  timestamp: number;
}

export interface DetectedPattern {
  type: "question" | "task" | "topic" | "time" | "workflow";
  description: string;
  occurrences: number;
  lastSeen: number;
  examples: string[];
  suggestedAction?: string;
}

export interface AutomationSuggestion {
  type: "mission" | "cron" | "shortcut";
  name: string;
  description: string;
  config: Record<string, unknown>;
}

export interface SessionInsight {
  type: string;
  description: string;
  data: unknown;
  period: "daily" | "weekly" | "monthly";
}

export interface SessionData {
  actions: ActionEntry[];
  lastPrune: number;
}

export const LAX_DIR = join(homedir(), ".lax");
export const DATA_FILE = join(LAX_DIR, "cross-session-data.json");
export const MAX_ACTIONS = 5000;
export const DEFAULT_MIN_OCCURRENCES = 3;
export const PRUNE_AGE_DAYS = 30;
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
