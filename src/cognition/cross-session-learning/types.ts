import { join } from "node:path";
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { getLaxDir } from "../../lax-data-dir.js";
import {
  INVALID_PROPERTY, MISSING_PROPERTY, denseArray, exactKeys, hasEvidenceIdentity,
  optional, ownDataValue, plainRecord, safeJson, stringArray,
} from "./safe-shape.js";

export { hasEvidenceIdentity, isSafeLearnedStringArray, readOwnEnumerableData } from "./safe-shape.js";

export type LearnedEvidenceClass = "workflow-tactic" | "terminal-telemetry" | "reviewed-procedure";
export type LearnedEvidenceAuthority = "cross-session-learning" | "canonical-operation" | "skill-review";

export interface LearnedEvidenceIdentity { evidenceClass: LearnedEvidenceClass; authority: LearnedEvidenceAuthority; }
interface PersistedLearnedEvidenceIdentity { evidenceClass?: LearnedEvidenceClass; authority?: LearnedEvidenceAuthority; }

export const WORKFLOW_TACTIC_IDENTITY = { evidenceClass: "workflow-tactic", authority: "cross-session-learning" } as const satisfies LearnedEvidenceIdentity;
export const TERMINAL_TELEMETRY_IDENTITY = { evidenceClass: "terminal-telemetry", authority: "canonical-operation" } as const satisfies LearnedEvidenceIdentity;
/** A procedure the post-turn review fork proposed after reading a finished
 *  turn and what the user said afterwards. Its evidence is the set of sessions
 *  that proposed it, not terminal telemetry. */
export const REVIEWED_PROCEDURE_IDENTITY = { evidenceClass: "reviewed-procedure", authority: "skill-review" } as const satisfies LearnedEvidenceIdentity;

/** "unverified" marks a proposal carried over from the pre-draft catalog: it
 *  keeps the procedure reviewable but never counts as independent evidence. */
export type ReviewedProposalOutcome = "verified" | "corrected" | "unverified";
export interface ReviewedProposal { sessionId: string; timestamp: number; outcome: ReviewedProposalOutcome; }
export const MAX_REVIEWED_PROPOSALS = 50;
export const REVIEWED_PROCEDURE_NAME = /^[a-z0-9][a-z0-9_]{1,47}$/;

export interface ActionEntry extends PersistedLearnedEvidenceIdentity {
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

export interface DetectedPattern extends PersistedLearnedEvidenceIdentity {
  sourceEvidence?: LearnedEvidenceIdentity;
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

export type LearnedCandidateState = "candidate" | "approved" | "active" | "rejected" | "archived" | "rolled-back";

export const CANDIDATE_TRANSITIONS: Record<LearnedCandidateState, LearnedCandidateState[]> = {
  candidate: ["approved", "rejected", "archived"], approved: ["active", "rejected", "archived"],
  active: ["archived", "rolled-back"], rejected: ["candidate", "archived"],
  archived: ["candidate"], "rolled-back": ["archived", "candidate"],
};

export type CandidatePatternType = DetectedPattern["type"] | "procedure";

export function deriveCandidateId(type: CandidatePatternType, description: string, examples: string[]): string {
  const normalized = description.trim().toLowerCase();
  const anchor = type === "time" ? normalized.replace(/ \(\d+ times\)$/, "")
    : normalized.match(/"([^"]+)"/)?.[1] ?? examples[0]?.trim().toLowerCase() ?? normalized;
  return `learned-${createHash("sha256").update(JSON.stringify([type, anchor])).digest("hex").slice(0, 20)}`;
}

export interface CandidateEvidenceSnapshot extends PersistedLearnedEvidenceIdentity {
  patternType: CandidatePatternType;
  description: string;
  occurrences: number;
  lastSeen: number;
  examples: string[];
  outcomeStats?: NonNullable<DetectedPattern["outcomeStats"]>;
  proposals?: ReviewedProposal[];
}

export interface CandidateTransition {
  from: LearnedCandidateState;
  to: LearnedCandidateState;
  timestamp: number;
  reason?: string;
}

export interface LearnedCandidate extends PersistedLearnedEvidenceIdentity {
  id: string;
  state: LearnedCandidateState;
  confidence: number;
  suggestion: AutomationSuggestion;
  evidence: CandidateEvidenceSnapshot;
  createdAt: number;
  updatedAt: number;
  rejectionCooldownUntil?: number;
  lastSurfacedAt?: number;
  lastSurfacedOccurrences?: number;
  surfaceCooldownUntil?: number;
  transitions: CandidateTransition[];
}

export interface SessionInsight {
  type: string;
  description: string;
  data: unknown;
  period: "daily" | "weekly" | "monthly";
}

// Type alias (not interface) so it satisfies json-store's Record constraint.
export type SessionData = { actions: ActionEntry[]; candidates: LearnedCandidate[]; lastPrune: number; };

const STATES = new Set<LearnedCandidateState>(["candidate", "approved", "active", "rejected", "archived", "rolled-back"]);
const PATTERNS = new Set<DetectedPattern["type"]>(["question", "task", "topic", "time", "workflow"]);
const ACTION_KEYS = new Set(["evidenceClass", "authority", "opId", "sessionId", "type", "details", "timestamp", "outcome", "category", "tools", "model"]);
const CANDIDATE_KEYS = new Set(["evidenceClass", "authority", "id", "state", "confidence", "suggestion", "evidence", "createdAt", "updatedAt", "rejectionCooldownUntil", "lastSurfacedAt", "lastSurfacedOccurrences", "surfaceCooldownUntil", "transitions"]);

function statsShape(value: unknown, occurrences: number): boolean {
  if (!plainRecord(value) || !exactKeys(value, new Set(["clean", "partial", "aborted", "successRate", "weightedSuccessRate", "distinctSessions"]), ["clean", "partial", "aborted", "successRate", "weightedSuccessRate", "distinctSessions"])) return false;
  const ints = ["clean", "partial", "aborted", "distinctSessions"].map((key) => ownDataValue(value, key));
  const rates = ["successRate", "weightedSuccessRate"].map((key) => ownDataValue(value, key));
  if (!ints.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)
    || !rates.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0 && entry <= 1)) return false;
  const [clean, partial, aborted, distinct] = ints as number[], [success, weighted] = rates as number[];
  return clean + partial + aborted === occurrences && distinct > 0 && distinct <= occurrences
    && Math.abs(success - clean / occurrences) <= Number.EPSILON
    && (clean === 0 ? weighted === 0 : clean === occurrences ? weighted === 1 : weighted > 0 && weighted < 1);
}

function evidenceShape(value: unknown): boolean {
  const allowed = new Set(["evidenceClass", "authority", "patternType", "description", "occurrences", "lastSeen", "examples", "outcomeStats"]);
  if (!plainRecord(value) || !exactKeys(value, allowed, ["patternType", "description", "occurrences", "lastSeen", "examples"])) return false;
  const pattern = ownDataValue(value, "patternType"), occurrences = ownDataValue(value, "occurrences"), lastSeen = ownDataValue(value, "lastSeen");
  const stats = ownDataValue(value, "outcomeStats");
  return typeof pattern === "string" && PATTERNS.has(pattern as DetectedPattern["type"])
    && typeof ownDataValue(value, "description") === "string"
    && typeof occurrences === "number" && Number.isInteger(occurrences) && occurrences >= 1
    && typeof lastSeen === "number" && Number.isFinite(lastSeen)
    && stringArray(ownDataValue(value, "examples"), 100)
    && (stats === MISSING_PROPERTY || (stats !== INVALID_PROPERTY && stats !== undefined
      && pattern === "workflow" && statsShape(stats, occurrences)));
}

function patternShape(value: unknown): boolean {
  const allowed = new Set(["evidenceClass", "authority", "sourceEvidence", "type", "description", "occurrences", "lastSeen", "examples", "suggestedAction", "automationEligible", "outcomeStats"]);
  if (!plainRecord(value) || !exactKeys(value, allowed, ["sourceEvidence", "type", "description", "occurrences", "lastSeen", "examples"])) return false;
  const type = ownDataValue(value, "type"), occurrences = ownDataValue(value, "occurrences"), lastSeen = ownDataValue(value, "lastSeen");
  const stats = ownDataValue(value, "outcomeStats");
  return typeof type === "string" && PATTERNS.has(type as DetectedPattern["type"])
    && typeof ownDataValue(value, "description") === "string"
    && typeof occurrences === "number" && Number.isInteger(occurrences) && occurrences >= 1
    && typeof lastSeen === "number" && Number.isFinite(lastSeen) && stringArray(ownDataValue(value, "examples"), 100)
    && optional(value, "suggestedAction", (entry) => typeof entry === "string")
    && optional(value, "automationEligible", (entry) => typeof entry === "boolean")
    && (stats === MISSING_PROPERTY || (stats !== INVALID_PROPERTY && stats !== undefined
      && type === "workflow" && statsShape(stats, occurrences)));
}

function transitionShape(value: unknown): boolean {
  const allowed = new Set(["from", "to", "timestamp", "reason"]);
  if (!plainRecord(value) || !exactKeys(value, allowed, ["from", "to", "timestamp"])) return false;
  const from = ownDataValue(value, "from"), to = ownDataValue(value, "to"), timestamp = ownDataValue(value, "timestamp");
  return typeof from === "string" && STATES.has(from as LearnedCandidateState)
    && typeof to === "string" && STATES.has(to as LearnedCandidateState)
    && typeof timestamp === "number" && Number.isFinite(timestamp)
    && optional(value, "reason", (entry) => typeof entry === "string");
}

function transitionHistoryShape(entries: unknown[], state: LearnedCandidateState, createdAt: number, updatedAt: number): boolean {
  if (entries.length === 0) return state === "candidate";
  let prior: LearnedCandidateState = "candidate", timestamp = createdAt;
  for (const entry of entries) {
    if (!transitionShape(entry)) return false;
    const from = ownDataValue(entry, "from") as LearnedCandidateState, to = ownDataValue(entry, "to") as LearnedCandidateState;
    const nextTimestamp = ownDataValue(entry, "timestamp") as number;
    if (from !== prior || !CANDIDATE_TRANSITIONS[from].includes(to)
      || nextTimestamp < timestamp || nextTimestamp > updatedAt) return false;
    prior = to; timestamp = nextTimestamp;
  }
  return prior === state;
}

function candidateShape(value: unknown): value is LearnedCandidate {
  return candidateEnvelopeShape(value, evidenceShape);
}

function proposalShape(value: unknown): boolean {
  const keys = ["sessionId", "timestamp", "outcome"];
  if (!plainRecord(value) || !exactKeys(value, new Set(keys), keys)) return false;
  const sessionId = ownDataValue(value, "sessionId"), timestamp = ownDataValue(value, "timestamp"), outcome = ownDataValue(value, "outcome");
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 200
    && typeof timestamp === "number" && Number.isFinite(timestamp)
    && typeof outcome === "string" && ["verified", "corrected", "unverified"].includes(outcome);
}

export function reviewedProcedureDescription(name: string): string {
  return `Reviewed procedure "${name}"`;
}

function reviewedEvidenceShape(value: unknown): boolean {
  const keys = ["evidenceClass", "authority", "patternType", "description", "occurrences", "lastSeen", "examples", "proposals"];
  if (!plainRecord(value) || !exactKeys(value, new Set(keys), keys)) return false;
  const examples = denseArray(ownDataValue(value, "examples"), 1), proposals = denseArray(ownDataValue(value, "proposals"), MAX_REVIEWED_PROPOSALS);
  const name = examples?.[0], occurrences = ownDataValue(value, "occurrences"), lastSeen = ownDataValue(value, "lastSeen");
  return hasEvidenceIdentity(value, REVIEWED_PROCEDURE_IDENTITY)
    && ownDataValue(value, "patternType") === "procedure"
    && typeof name === "string" && REVIEWED_PROCEDURE_NAME.test(name)
    && ownDataValue(value, "description") === reviewedProcedureDescription(name)
    && proposals !== null && proposals.length >= 1 && proposals.every(proposalShape)
    && occurrences === proposals.length
    && typeof lastSeen === "number" && Number.isFinite(lastSeen);
}

function reviewedCandidateShape(value: unknown): value is LearnedCandidate {
  if (!candidateEnvelopeShape(value, reviewedEvidenceShape)) return false;
  const suggestion = ownDataValue(value, "suggestion"), config = ownDataValue(suggestion, "config");
  const description = ownDataValue(suggestion, "description"), examples = ownDataValue(ownDataValue(value, "evidence"), "examples");
  return ownDataValue(suggestion, "type") === "mission"
    && ownDataValue(suggestion, "name") === (examples as string[])[0]
    && typeof description === "string" && description.length <= 300 && !/[\r\n]/.test(description)
    && plainRecord(config) && exactKeys(config, new Set(["patternType", "occurrences"]), ["patternType", "occurrences"]);
}

export function isReviewedProcedureCandidate(value: unknown): value is LearnedCandidate {
  return hasEvidenceIdentity(value, REVIEWED_PROCEDURE_IDENTITY) && reviewedCandidateShape(value);
}

function candidateEnvelopeShape(value: unknown, evidenceValid: (evidence: unknown) => boolean): value is LearnedCandidate {
  if (!plainRecord(value) || !exactKeys(value, CANDIDATE_KEYS, ["id", "state", "confidence", "suggestion", "evidence", "createdAt", "updatedAt", "transitions"])) return false;
  const id = ownDataValue(value, "id"), state = ownDataValue(value, "state"), confidence = ownDataValue(value, "confidence");
  const suggestion = ownDataValue(value, "suggestion"), evidence = ownDataValue(value, "evidence"), transitions = denseArray(ownDataValue(value, "transitions"), 1000);
  const createdAt = ownDataValue(value, "createdAt"), updatedAt = ownDataValue(value, "updatedAt");
  if (!plainRecord(suggestion) || !exactKeys(suggestion, new Set(["type", "name", "description", "config"]), ["type", "name", "description", "config"])) return false;
  const config = ownDataValue(suggestion, "config"), pattern = ownDataValue(evidence, "patternType");
  const configOccurrences = ownDataValue(config, "occurrences"), evidenceOccurrences = ownDataValue(evidence, "occurrences");
  const numeric = ["rejectionCooldownUntil", "lastSurfacedAt", "surfaceCooldownUntil"];
  return typeof id === "string" && /^learned-[a-f0-9]{20}$/.test(id)
    && typeof state === "string" && STATES.has(state as LearnedCandidateState)
    && typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    && typeof ownDataValue(suggestion, "type") === "string"
    && ["mission", "cron", "shortcut"].includes(ownDataValue(suggestion, "type") as string)
    && typeof ownDataValue(suggestion, "name") === "string" && typeof ownDataValue(suggestion, "description") === "string"
    && plainRecord(config) && safeJson(config) && ownDataValue(config, "patternType") === pattern
    && typeof configOccurrences === "number" && Number.isInteger(configOccurrences) && configOccurrences === evidenceOccurrences
    && (pattern !== "workflow" || stringArray(ownDataValue(config, "sequence")))
    && evidenceValid(evidence) && id === deriveCandidateId(pattern as CandidatePatternType, ownDataValue(evidence, "description") as string, ownDataValue(evidence, "examples") as string[])
    && typeof createdAt === "number" && Number.isFinite(createdAt)
    && typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt >= createdAt
    && numeric.every((key) => optional(value, key, (entry) => typeof entry === "number" && Number.isFinite(entry)))
    && optional(value, "lastSurfacedOccurrences", (entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)
    && transitions !== null && transitionHistoryShape(transitions, state as LearnedCandidateState, createdAt, updatedAt);
}

function actionShape(value: unknown, terminal: boolean): value is ActionEntry {
  if (!plainRecord(value) || !exactKeys(value, ACTION_KEYS, ["sessionId", "type", "details", "timestamp"])) return false;
  const type = ownDataValue(value, "type"), timestamp = ownDataValue(value, "timestamp");
  if (typeof ownDataValue(value, "sessionId") !== "string" || typeof type !== "string" || !type
    || typeof ownDataValue(value, "details") !== "string" || typeof timestamp !== "number" || !Number.isFinite(timestamp)) return false;
  const terminalKeys = ["opId", "outcome", "category", "tools"];
  if (!terminal) return type !== "op_outcome" && terminalKeys.every((key) => ownDataValue(value, key) === MISSING_PROPERTY)
    && ownDataValue(value, "model") === MISSING_PROPERTY;
  const outcome = ownDataValue(value, "outcome"), category = ownDataValue(value, "category"), opId = ownDataValue(value, "opId");
  return type === "op_outcome" && typeof opId === "string" && !!opId
    && typeof outcome === "string" && ["clean", "partial", "aborted"].includes(outcome)
    && typeof category === "string" && ["browser", "computer", "coding", "connector", "research", "general"].includes(category)
    && stringArray(ownDataValue(value, "tools"), 1000) && optional(value, "model", (entry) => typeof entry === "string");
}

export function isExactTerminalTelemetryAction(value: unknown): value is ActionEntry & { opId: string; outcome: NonNullable<ActionEntry["outcome"]>; category: NonNullable<ActionEntry["category"]>; tools: string[] } {
  return hasEvidenceIdentity(value, TERMINAL_TELEMETRY_IDENTITY) && actionShape(value, true);
}

export function isExactWorkflowTacticAction(value: unknown): value is ActionEntry {
  return hasEvidenceIdentity(value, WORKFLOW_TACTIC_IDENTITY) && actionShape(value, false);
}

export function hasPatternEvidenceIdentity(value: unknown): value is DetectedPattern {
  if (!hasEvidenceIdentity(value, WORKFLOW_TACTIC_IDENTITY) || !patternShape(value)) return false;
  const source = ownDataValue(value, "sourceEvidence"), stats = ownDataValue(value, "outcomeStats");
  const expected = stats === MISSING_PROPERTY ? WORKFLOW_TACTIC_IDENTITY : TERMINAL_TELEMETRY_IDENTITY;
  return !!source && typeof source === "object" && !isProxy(source)
    && Object.getPrototypeOf(source) === Object.prototype
    && exactKeys(source, new Set(["evidenceClass", "authority"]), ["evidenceClass", "authority"])
    && hasEvidenceIdentity(source, expected);
}

export function hasCandidateEvidenceIdentity(value: unknown): value is LearnedCandidate {
  if (hasEvidenceIdentity(value, REVIEWED_PROCEDURE_IDENTITY)) return isReviewedProcedureCandidate(value);
  if (!hasEvidenceIdentity(value, WORKFLOW_TACTIC_IDENTITY) || !candidateShape(value)) return false;
  const evidence = ownDataValue(value, "evidence"), stats = ownDataValue(evidence, "outcomeStats");
  return hasEvidenceIdentity(evidence, stats === MISSING_PROPERTY ? WORKFLOW_TACTIC_IDENTITY : TERMINAL_TELEMETRY_IDENTITY);
}

export function sanitizeLearnedCandidate(value: unknown): LearnedCandidate | null {
  if (!hasCandidateEvidenceIdentity(value)) return null;
  try { return structuredClone(value); } catch { return null; }
}

function identityless(value: unknown): value is Record<string, unknown> {
  if (!plainRecord(value) || ownDataValue(value, "evidenceClass") !== MISSING_PROPERTY || ownDataValue(value, "authority") !== MISSING_PROPERTY) return false;
  try {
    for (let current = Object.getPrototypeOf(value); current; current = Object.getPrototypeOf(current)) {
      if (isProxy(current) || Object.getOwnPropertyDescriptor(current, "evidenceClass") || Object.getOwnPropertyDescriptor(current, "authority")) return false;
    }
  } catch { return false; }
  return true;
}

function stamp(value: object, identity: LearnedEvidenceIdentity): boolean {
  if (!Object.isExtensible(value)) return false;
  Object.defineProperties(value, { evidenceClass: { configurable: true, enumerable: true, value: identity.evidenceClass, writable: true }, authority: { configurable: true, enumerable: true, value: identity.authority, writable: true } });
  return true;
}

export function normalizeLegacyEvidenceIdentities(data: SessionData): boolean {
  if (!plainRecord(data) || !exactKeys(data, new Set(["actions", "candidates", "lastPrune"]), ["actions", "candidates", "lastPrune"])) return false;
  const actions = denseArray(ownDataValue(data, "actions"), MAX_ACTIONS), candidates = denseArray(ownDataValue(data, "candidates"), 5000), lastPrune = ownDataValue(data, "lastPrune");
  if (!actions || !candidates || typeof lastPrune !== "number" || !Number.isFinite(lastPrune)) return false;
  let changed = false;
  for (const action of actions) {
    if (!identityless(action)) continue;
    if (actionShape(action, true)) changed = stamp(action, TERMINAL_TELEMETRY_IDENTITY) || changed;
    else if (actionShape(action, false)) changed = stamp(action, WORKFLOW_TACTIC_IDENTITY) || changed;
  }
  for (const candidate of candidates) {
    if (!identityless(candidate) || !candidateShape(candidate)) continue;
    const evidence = ownDataValue(candidate, "evidence"), stats = ownDataValue(evidence, "outcomeStats");
    if (!identityless(evidence) || !Object.isExtensible(candidate) || !Object.isExtensible(evidence)) continue;
    stamp(candidate, WORKFLOW_TACTIC_IDENTITY);
    stamp(evidence, stats === MISSING_PROPERTY ? WORKFLOW_TACTIC_IDENTITY : TERMINAL_TELEMETRY_IDENTITY);
    changed = true;
  }
  return changed;
}

export const LAX_DIR = getLaxDir();
export const DATA_FILE = join(LAX_DIR, "cross-session-data.json");
export const MAX_ACTIONS = 5000, DEFAULT_MIN_OCCURRENCES = 3;
export const PRUNE_AGE_DAYS = 30, REJECTION_COOLDOWN_DAYS = 30;
export const CANDIDATE_SURFACE_COOLDOWN_DAYS = 7;
export const MS_PER_DAY = 86400000;

export const STOP_WORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "about", "that", "this", "it", "its", "and", "or", "but", "not", "if", "then", "so", "what", "how", "when", "where", "who", "which", "there", "here", "i", "me", "my", "you", "your", "we", "our", "they", "them", "their"]);
