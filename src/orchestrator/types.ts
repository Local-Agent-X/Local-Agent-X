import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

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

export const LAX_DIR = getLaxDir();
export const EXAMPLES_FILE = join(LAX_DIR, "orchestration-examples.json");
export const STATE_FILE = join(LAX_DIR, "orchestrator-state.json");
export const MAX_EXAMPLES = 200;

export const MAX_CONTEXT_SIGNALS = 7;
export const MAX_CONTEXT_TOKENS = 200;

/**
 * Per-signal scope classification for cross-session bleed control.
 *
 * - "profile" signals describe the user as a stable entity (emotion arc,
 *   stylistic patterns, trust stage, growth, milestones, retained facts).
 *   They're safe to surface in any session — they're about *who you are*,
 *   not *what we discussed in chat #47*.
 *
 * - "session" signals pull content that could have originated in a
 *   different conversation (callbacks, followups, cross-session recall,
 *   ongoing narratives). They must pass an additional topical-relevance
 *   gate so a "logo work for X" memory doesn't surface when the user is
 *   writing about an unrelated topic.
 *
 * A signal's scope is declared once, on its registry entry (registry.ts).
 * An entry with no scope defaults to "profile" (flows freely) — set it
 * deliberately; forgetting is a quiet leak.
 */
export type ModuleScope = "profile" | "session";

export type TriageBucket = "always" | "conditional" | "scheduled" | "triggered";

export interface SignalContext {
  input: OrchestratorInput;
  msgCount: number;
}

export interface VetoOutcome {
  reason: string;
  overrideSignal: ModuleSignal;
}

/**
 * One cognitive signal module, declared once. The orchestrator iterates the
 * registry (registry.ts) for every facet — triage, dispatch, recording,
 * veto, scope, health — so a module's identity lives in exactly one place
 * instead of being restated as a string across five files.
 *
 * Facets are optional: a recall module defines `run`; a passive learner
 * defines `record`; a background store defines only `health`.
 */
export interface CognitiveSignal {
  id: string;
  scope: ModuleScope;
  /** Member of the deep-pass critical set — re-run on a wider window when low-confidence. */
  critical?: boolean;
  /** Which triage bucket this runs in for the current message, or null to skip. */
  triage?(ctx: SignalContext): TriageBucket | null;
  /** Gather signals for the current message; push them into `out`. */
  run?(input: OrchestratorInput, out: ModuleSignal[]): void;
  /** Passive learning from the message; emits no signal. */
  record?(input: OrchestratorInput): void;
  /** Escalate one of this module's signals to a turn-overriding veto, or null to pass. */
  veto?(sig: ModuleSignal): VetoOutcome | null;
  /** Liveness probe for the health report; throws or returns falsy when unloaded. */
  health?(): unknown;
  /** Persisted-state filename under LAX_DIR, surfaced in the health report's storageSizes (keyed by id). */
  storageFile?: string;
}
