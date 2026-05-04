import { join } from "node:path";
import { homedir } from "node:os";

export const GRAPH_STOP_WORDS = new Set([
  "the", "this", "that", "what", "when", "where", "which", "who", "how",
  "can", "could", "would", "should", "will", "shall", "may", "might",
  "has", "have", "had", "was", "were", "been", "being", "are", "also",
  "just", "not", "but", "and", "for", "with", "from", "into", "about",
  "then", "than", "very", "here", "there", "some", "any", "all", "most",
  "other", "each", "every", "both", "few", "more", "many", "such",
  "new", "old", "good", "bad", "great", "big", "small", "long", "short",
  "let", "get", "got", "set", "put", "use", "try", "run", "see", "say",
  "yes", "hey", "sure", "okay", "thanks", "please", "sorry", "now",
]);

export interface OrchestratorInput {
  message: string;
  sessionId: string;
  sessionMessages: { role: string; content: string }[];
  timeOfDay: number;
  dayOfWeek: number;
  agentPreviousMessage?: string;
}

export interface Adaptation {
  type: string;
  instruction: string;
  priority: number;
}

export interface Notification {
  type: "milestone" | "followup" | "insight" | "celebration";
  message: string;
  priority: number;
}

export interface DebugInfo {
  modulesActivated: string[];
  totalTimeMs: number;
  signals: Record<string, unknown>;
}

export interface OrchestratorOutput {
  contextInjection: string;
  adaptations: Adaptation[];
  notifications: Notification[];
  debug: DebugInfo;
}

export interface ModuleSignal {
  source: string;
  signal: string;
  priority: number;
  category: string;
  confidence: number;
}

export interface FusionResult {
  signals: ModuleSignal[];
  fusionConfidence: number;
  vetoApplied: boolean;
  vetoReason?: string;
  deepPassTriggered: boolean;
}

export interface OrchestrationExample {
  input: { message: string; timeOfDay: number };
  modulesActivated: string[];
  signals: ModuleSignal[];
  output: string;
  quality: "good" | "bad" | "neutral";
  timestamp: number;
  notes?: string;
}

export interface BackgroundReport {
  compression: { compressed: number; savedBytes: number };
  tierChanges: { hot: number; warm: number; cold: number; archive: number };
  prefetch: { topics: string[] };
  unspoken: { absences: number; changes: number };
  growth: string;
  narratives: number;
  graphEdges: number;
  importanceScored: number;
  totalTimeMs: number;
}

export interface HealthReport {
  modulesLoaded: string[];
  storageSizes: Record<string, number>;
  lastRunTimes: Record<string, number>;
  errorCounts: Record<string, number>;
  uptime: number;
}

export interface OrchestratorState {
  messageCount: number;
  lastProcessedAt: number;
  lastBackgroundRun: number;
  lastSignalHashes: string[];
  errorLog: { module: string; error: string; timestamp: number }[];
  moduleRunTimes: Record<string, number>;
}

export interface TriageResult {
  always: string[];
  conditional: string[];
  scheduled: string[];
  triggered: string[];
}

export const LAX_DIR = join(homedir(), ".lax");
export const EXAMPLES_FILE = join(LAX_DIR, "orchestration-examples.json");
export const STATE_FILE = join(LAX_DIR, "orchestrator-state.json");
export const MAX_EXAMPLES = 200;

export const SENSITIVE_KEYWORDS = [
  "died", "death", "passed away", "cancer", "depression", "anxiety",
  "breakup", "divorce", "fired", "laid off", "suicide", "abuse",
  "scared", "terrified", "lonely", "grief", "lost my", "struggling",
  "overwhelmed", "panic", "hurt", "trauma", "sick", "hospital",
  "emergency", "miscarriage", "relapse", "addiction",
];

export const CORRECTION_KEYWORDS = [
  "no", "wrong", "incorrect", "not what", "that's not", "actually",
  "i meant", "you misunderstood", "i said", "nope", "nah",
  "that's wrong", "fix this", "you got it wrong",
];

export const FACT_PATTERNS = [
  /\bi (am|work|live|use|prefer|like|hate|love|have|need|want)\b/i,
  /\bmy (name|job|project|favorite|preference|dog|cat|wife|husband|kid)\b/i,
  /\bi('m| am) (a |an )?[a-z]+ (developer|engineer|designer|manager|student)/i,
  /\bi (moved|switched|changed|started|quit|joined)\b/i,
];

export const STORY_PATTERNS = [
  /\bso (basically|what happened|the thing is|long story)\b/i,
  /\byesterday|last (week|month|night|year)\b/i,
  /\bremember when\b/i,
  /\bback when\b/i,
  /\bthe other day\b/i,
];

export const MAX_CONTEXT_SIGNALS = 7;
export const MAX_CONTEXT_TOKENS = 200;

/**
 * Per-module scope classification for cross-session bleed control.
 *
 * - "profile" modules describe the user as a stable entity (emotion arc,
 *   stylistic patterns, trust stage, growth, milestones, retained facts).
 *   Their signals are safe to surface in any session — they're about *who
 *   you are*, not *what we discussed in chat #47*.
 *
 * - "session" modules pull content that could have originated in a
 *   different conversation (callbacks, followups, cross-session recall,
 *   ongoing narratives). Their signals must pass an additional topical-
 *   relevance gate so a "logo work for X" memory doesn't surface when the
 *   user is writing about an unrelated topic.
 *
 * If a new module is added without an entry here, the orchestrator
 * defaults it to "profile" (signal flows freely) — but you should add
 * the entry. Forgetting is a quiet leak.
 */
export type ModuleScope = "profile" | "session";

export const MODULE_SCOPE: Record<string, ModuleScope> = {
  // profile — about the user as a stable entity
  "emotional-memory": "profile",
  "language-mirror": "profile",
  "trust-engine": "profile",
  "vulnerability-awareness": "profile",
  "shared-history": "profile",
  "cross-session-learning": "profile",
  "unspoken-detector": "profile",
  "growth-tracker": "profile",
  "milestone-celebrations": "profile",
  "correction-learning": "profile",
  "contradiction-detector": "profile",
  "memory-graph": "profile",
  "proactive-memory": "profile",
  // session — pulls from a global pool of past-conversation content
  "inside-references": "session",
  "anticipatory-care": "session",
  "associative-recall": "session",
  "narrative-memory": "session",
};

export function getModuleScope(moduleName: string): ModuleScope {
  return MODULE_SCOPE[moduleName] ?? "profile";
}
