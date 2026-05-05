/**
 * Worker pool types — Op model + IPC message envelopes.
 *
 * Step 1 (foundation) of the supervisor architecture. Some fields from the
 * full spec are deferred to later steps:
 *   - dependsOn / outputContract / inputBindings → Step 5 (DAG scheduler)
 *   - resourceLocks → Step 10 (GPU semaphore + general locks)
 *   - retryPolicy registry → Step 3 (heartbeat + lease + recovery)
 * The shape leaves room for them; current code just doesn't use them yet.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// ── Op model ───────────────────────────────────────────────────────────────

export type OpStatus =
  | "pending"        // waiting in queue, not yet assigned
  | "running"        // assigned to a worker, in flight
  | "paused"         // user requested pause; worker stopped at safe boundary
  | "completed"      // finished successfully
  | "failed"         // unrecoverable failure (after retry caps)
  | "cancelled"      // user-killed or upstream-failed
  | "needs-input"    // worker is blocked, waiting on user
  | "merge-conflict-pending"; // worktree result has conflicts to resolve

export type OpLane = "interactive" | "build" | "background";

export type OpVisibility = "private" | "project" | "org";

/**
 * The supervisor delegates this to a worker. The worker uses it to spawn
 * a sub-agent with everything it needs to act competently. Pre-baking
 * context here is the difference between "junior dev" and "engineer who
 * has been on the team for a month."
 */
export interface ContextPack {
  task: {
    description: string;          // expanded, not "build the kraken bot"
    successCriteria: string[];    // explicit "you're done when..."
    constraints: string[];        // "don't touch the auth layer"
    notWhatToRedo: string[];      // "kraken-tradingbot already exists; extend it"
  };
  context: {
    recentTurns: ChatCompletionMessageParam[];   // last N turns from parent session
    referencedFiles: FileSnapshot[];             // files the parent mentioned, pre-loaded
    memoryHits: MemoryHit[];                     // pre-fetched memory matches
    agentsRules: string;                         // collected AGENTS.md from scope
  };
  capabilities: ProviderCapabilityRequirement;
  budget: OpBudget;
  routing: { lane: OpLane; preferredProvider?: string };
  secrets: { allowed: string[] };               // names only, never values (§12)
}

export interface FileSnapshot {
  path: string;
  content: string;          // truncated to a sane size by the builder
  truncated: boolean;
}

export interface MemoryHit {
  source: string;           // which memory file this came from
  snippet: string;
  score?: number;
}

export interface ProviderCapabilityRequirement {
  needsTools?: boolean;
  needsVision?: boolean;
  needsLongContext?: boolean;
  needsStreaming?: boolean;
  needsJsonMode?: boolean;
  needsLocalFiles?: boolean;
}

export interface OpBudget {
  maxIterations: number;
  maxTokens: number;
  maxWallTimeMs: number;
  maxSelfEditCalls: number;
}

export interface OpRetryPolicy {
  maxRecoveryAttempts: number;
  backoffMs: number[];
}

export interface Op {
  id: string;
  type: string;                           // "build_app" | "research" | "self_edit" | freeform
  task: string;                           // user-facing one-line description
  contextPack: ContextPack;
  lane: OpLane;
  retryPolicy: OpRetryPolicy;
  ownerId: string;
  visibility: OpVisibility;
  projectId?: string;
  status: OpStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  workerId?: string;
  attemptCount: number;
  lastFailureReason?: string;
  lastFailureAt?: string;
  // Reserved for later steps:
  dependsOn?: string[];
  outputContract?: string[];
  inputBindings?: Record<string, string>;
  resourceLocks?: string[];
  /**
   * Additive canonical-loop fields (PRD §9). Optional sub-object so legacy
   * consumers ignore it; canonical-loop is the sole writer. Absent on every
   * op submitted under flag OFF and on every op created before Issue 01.
   * See src/canonical-loop/types.ts for the full shape.
   */
  canonical?: import("../canonical-loop/types.js").CanonicalOpFields;
}

// ── Op events (streamed worker→supervisor→subscribers, also disked) ─────

export type OpEventType =
  | "started"
  | "phase"           // worker entered a logical phase ("planning", "writing files", "validating")
  | "tool_call"       // a tool invocation
  | "tool_result"     // tool finished (may be redacted)
  | "agent_text"      // assistant text token / chunk
  | "checkpoint"      // worker wrote a checkpoint (pointer event; full state in checkpoint.json)
  | "warning"
  | "error"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"
  | "needs_input";

export interface OpEvent {
  opId: string;
  type: OpEventType;
  ts: string;
  /** True if any payload field was redacted before disk-write. */
  redacted?: boolean;
  /**
   * Hint for the redactor: when true, skip persisting this event's payload
   * to disk entirely (live UI sees it via WS, disk gets a stub). Tools tag
   * results with this when their output is intrinsically sensitive.
   */
  sensitive?: boolean;
  payload: Record<string, unknown>;
}

// ── Op result (worker→supervisor when op finishes) ───────────────────────

export interface OpResult {
  opId: string;
  status: "completed" | "failed" | "cancelled" | "needs-input" | "paused";
  finalSummary: string;       // one-liner the supervisor can show the user
  filesChanged: string[];
  artifactPaths?: string[];   // disk paths to op artifacts
  error?: { message: string; recoverable: boolean };
}

// ── Checkpoint (resume state — separate from event log) ──────────────────

export interface OpCheckpoint {
  opId: string;
  updatedAt: string;
  plan: PlanStep[];
  completedSteps: number;
  worktreeBranch: string | null;
  lastCommitSha: string | null;
  changedFiles: string[];
  pendingInstructions: string[];     // injected via redirect, not yet consumed
  providerUsed: string;
  retryCount: number;
  lastSafeBoundary: { label: string; timestamp: string };
}

export interface PlanStep {
  index: number;
  description: string;
  status: "pending" | "running" | "completed" | "skipped" | "failed";
}

// ── IPC envelope (supervisor ↔ worker over stdio) ────────────────────────

export const IPC_PROTOCOL_VERSION = 1 as const;

export type IpcMessage =
  | IpcAssignOp
  | IpcRedirect
  | IpcPause
  | IpcKill
  | IpcPing
  | IpcEvent
  | IpcCheckpoint
  | IpcResult
  | IpcPong
  | IpcReady
  | IpcLogLine;

interface IpcEnvelope<T extends string, P> {
  protocolVersion: typeof IPC_PROTOCOL_VERSION;
  messageId: string;
  type: T;
  ts: string;
  payload: P;
}

// supervisor → worker
export type IpcAssignOp   = IpcEnvelope<"assign-op",  { op: Op }>;
export type IpcRedirect   = IpcEnvelope<"redirect",   { opId: string; instruction: string }>;
export type IpcPause      = IpcEnvelope<"pause",      { opId: string; tier: "reasoning" | "tool" | "phase" }>;
export type IpcKill       = IpcEnvelope<"kill",       { opId?: string }>;     // opId optional = kill worker
export type IpcPing       = IpcEnvelope<"ping",       { fromTs: string }>;

// worker → supervisor
export type IpcReady      = IpcEnvelope<"ready",      { workerId: string; pid: number; capabilities: string[] }>;
export type IpcEvent      = IpcEnvelope<"event",      { event: OpEvent }>;
export type IpcCheckpoint = IpcEnvelope<"checkpoint", { checkpoint: OpCheckpoint }>;
export type IpcResult     = IpcEnvelope<"result",     { result: OpResult }>;
export type IpcPong       = IpcEnvelope<"pong",       {
  workerId: string;
  currentOpId: string | null;
  currentPhase: string | null;
  lastEventTs: string | null;
  heapMb: number;
  uptimeS: number;
}>;
export type IpcLogLine    = IpcEnvelope<"log",        { level: "debug"|"info"|"warn"|"error"; line: string }>;

export function ipcEnvelope<T extends string, P>(type: T, payload: P): IpcEnvelope<T, P> {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    messageId: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    ts: new Date().toISOString(),
    payload,
  };
}
