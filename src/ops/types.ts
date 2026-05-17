/**
 * Op model — Op, ContextPack, OpEvent, OpResult, OpCheckpoint.
 *
 * The Op shape is the lingua franca between submitters (op_submit_async,
 * delegation-handoff) and the canonical-loop runtime. Some optional fields
 * (dependsOn, outputContract, inputBindings, resourceLocks) are reserved
 * for future DAG / locking work and currently unused.
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
  /**
   * Model identifier the op should run against. Set at op creation from the
   * resolved provider+model (see resolve-provider.ts) so canonical-loop's
   * host middleware (host.ts) can read op.model directly instead of
   * re-resolving from settings.json — which doesn't seed model on fresh
   * installs after commit 4c9e5c4.
   */
  model?: string;
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

