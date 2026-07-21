import { join } from "node:path";
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { getLaxDir } from "../../lax-data-dir.js";

export type LearnedEvidenceClass = "workflow-tactic" | "terminal-telemetry";
export type LearnedEvidenceAuthority = "cross-session-learning" | "canonical-operation";

export interface LearnedEvidenceIdentity { evidenceClass: LearnedEvidenceClass; authority: LearnedEvidenceAuthority; }
interface PersistedLearnedEvidenceIdentity { evidenceClass?: LearnedEvidenceClass; authority?: LearnedEvidenceAuthority; }

export const WORKFLOW_TACTIC_IDENTITY = { evidenceClass: "workflow-tactic", authority: "cross-session-learning" } as const satisfies LearnedEvidenceIdentity;
export const TERMINAL_TELEMETRY_IDENTITY = { evidenceClass: "terminal-telemetry", authority: "canonical-operation" } as const satisfies LearnedEvidenceIdentity;

const MISSING_PROPERTY = Symbol("missing-property");
const INVALID_PROPERTY = Symbol("invalid-property");

function ownDataValue(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== "object" || isProxy(value)) return INVALID_PROPERTY;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return MISSING_PROPERTY;
    return descriptor.enumerable && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : INVALID_PROPERTY;
  } catch {
    return INVALID_PROPERTY;
  }
}

export function readOwnEnumerableData(value: unknown, key: PropertyKey): { ok: true; value: unknown } | { ok: false } {
  const result = ownDataValue(value, key);
  return result === MISSING_PROPERTY || result === INVALID_PROPERTY ? { ok: false } : { ok: true, value: result };
}

export function hasEvidenceIdentity(value: unknown, expected: LearnedEvidenceIdentity): boolean {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  try {
    if (Array.isArray(value)) return false;
    const expectedClass = ownDataValue(expected, "evidenceClass");
    const expectedAuthority = ownDataValue(expected, "authority");
    if (typeof expectedClass !== "string" || typeof expectedAuthority !== "string") return false;
    const evidenceClass = Object.getOwnPropertyDescriptor(value, "evidenceClass");
    const authority = Object.getOwnPropertyDescriptor(value, "authority");
    return !!evidenceClass && !!authority && evidenceClass.enumerable === true && authority.enumerable === true
      && Object.hasOwn(evidenceClass, "value") && Object.hasOwn(authority, "value")
      && evidenceClass.value === expectedClass && authority.value === expectedAuthority;
  } catch { return false; }
}

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

export function deriveCandidateId(type: DetectedPattern["type"], description: string, examples: string[]): string {
  const normalized = description.trim().toLowerCase();
  const anchor = type === "time" ? normalized.replace(/ \(\d+ times\)$/, "")
    : normalized.match(/"([^"]+)"/)?.[1] ?? examples[0]?.trim().toLowerCase() ?? normalized;
  return `learned-${createHash("sha256").update(JSON.stringify([type, anchor])).digest("hex").slice(0, 20)}`;
}

export interface CandidateEvidenceSnapshot extends PersistedLearnedEvidenceIdentity {
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

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  try { return !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}

function exactKeys(value: object, allowed: ReadonlySet<string>, required: readonly string[] = []): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return false;
    if (required.some((key) => !keys.includes(key))) return false;
    return keys.every((key) => key === "length" || ownDataValue(value, key) !== INVALID_PROPERTY);
  } catch { return false; }
}

function denseArray(value: unknown, maxLength = 5000): unknown[] | null {
  if (!value || typeof value !== "object" || isProxy(value)) return null;
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !Object.hasOwn(length, "value") || !Number.isSafeInteger(length.value)
      || length.value < 0 || length.value > maxLength) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length.value + 1 || keys.some((key) => typeof key !== "string")) return null;
    const copy: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      const entry = ownDataValue(value, String(index));
      if (entry === MISSING_PROPERTY || entry === INVALID_PROPERTY) return null;
      copy.push(entry);
    }
    return copy;
  } catch { return null; }
}

function stringArray(value: unknown, maxLength = 1000): value is string[] {
  const items = denseArray(value, maxLength);
  return items !== null && items.every((item) => typeof item === "string");
}

export function isSafeLearnedStringArray(value: unknown): value is string[] { return stringArray(value); }

function optional(value: object, key: string, valid: (entry: unknown) => boolean): boolean {
  const entry = ownDataValue(value, key);
  return entry === MISSING_PROPERTY || (entry !== INVALID_PROPERTY && entry !== undefined && valid(entry));
}

function safeJson(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || isProxy(value) || seen.has(value)) return false;
  seen.add(value);
  const array = denseArray(value);
  if (array) return array.every((entry) => safeJson(entry, seen));
  if (!plainRecord(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.every((key) => typeof key === "string" && ownDataValue(value, key) !== INVALID_PROPERTY
      && safeJson(ownDataValue(value, key), seen));
  } catch { return false; }
}

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
    && evidenceShape(evidence) && id === deriveCandidateId(pattern as DetectedPattern["type"], ownDataValue(evidence, "description") as string, ownDataValue(evidence, "examples") as string[])
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
