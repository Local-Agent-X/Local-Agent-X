/**
 * Op model — Op, ContextPack, OpEvent, OpResult, OpCheckpoint.
 *
 * The Op shape is the lingua franca between submitters (op_submit_async,
 * delegation-handoff) and the canonical-loop runtime. Some optional fields
 * (outputContract, inputBindings) are reserved for later materialization.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { CredentialSource } from "../auth/auth-provider.js";
import type { PromptTelemetry } from "../prompt-telemetry.js";
import type { ThreatEngineState } from "../threat/threat-engine.js";

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

export type OpLane = "interactive" | "build" | "background" | "agent";

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
  routing: {
    lane: OpLane;
    preferredProvider?: string;
    authSource?: CredentialSource;
    /** Caller-declared target pin. Absence means preference/default, not a pin. */
    targetPin?: TargetPin;
  };
  /** Content-free prompt sizing captured before dispatch and persisted with the op. */
  promptTelemetry?: PromptTelemetry;
  secrets: {
    allowed: string[];                          // names only, never values (§12)
    /** Names the user pre-blessed at submit (op_submit_async pre_blessed_secrets):
     *  while this op is running, browser_fill_from_secret skips the first-use
     *  approval gate for these names on their bound origin. See ops/pre-bless.ts. */
    preBlessed?: string[];
  };
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
  /** Explicit hard floor. Effective request sizing may raise it. */
  minimumContextTokens?: number;
  /** Hard locality boundary; "any" is represented by absence. */
  locality?: "local-only";
}

export interface TargetPin {
  provider?: import("../providers/provider-ids.js").ProviderId;
  model?: string;
}

export type CapabilityVerdict = "supported" | "unsupported" | "unknown";

/** Content-free facts captured for the exact signed runtime target at admission. */
export interface PersistedTargetCapabilitySnapshot {
  targetIdentity: string;
  tools: CapabilityVerdict;
  /** A learned exact endpoint/model rejection dominates earlier certification. */
  toolsRejected: boolean;
  vision: CapabilityVerdict;
  streaming: CapabilityVerdict;
  jsonMode: CapabilityVerdict;
  localFiles: CapabilityVerdict;
  contextWindowTokens: number | null;
  locality: "local" | "remote" | "unknown";
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

export interface AppBuildRuntimeDescriptor {
  kind: "app-build";
  strategy: "cli-subprocess" | "in-canonical-sub-agent";
  provider: string;
  appName: string;
  appDir: string;
  appUrl: string;
  prompt: string;
  brief: string;
  systemPrompt: string;
  adapterSessionId?: string;
  model?: string;
  tier?: "quick-html" | "frontend-spa" | "full-stack" | "compiled-native";
}

export type DelegatedProviderRuntime = "anthropic" | "codex" | "gemini-native" | "openai-compat";

export type DelegatedRuntimeTarget =
  | { kind: "provider-registry"; endpointFingerprint: string }
  | { kind: "custom-config"; endpointFingerprint: string; locality?: "local" | "remote" }
  | { kind: "ollama-cloud"; endpointFingerprint: string }
  | { kind: "local-runtime"; runtimeId: string; endpointFingerprint: string }
  | { kind: "local-config"; endpointFingerprint: string };

export interface DelegatedRuntimeSurface {
  kind: "agent-runner";
  systemPrompt: string;
  tools: Array<{ name: string; fingerprint: string }>;
  security: {
    workspace: string;
    fileAccessMode: import("../security/layer/index.js").FileAccessMode;
    inlineEvalPolicy: import("../security/layer/index.js").InlineEvalPolicy;
    allowedPaths: Array<{ sessionId: string; path: string }>;
    sessionWorkRoot?: string;
    configFingerprint: string;
  };
  toolPolicyFingerprint?: string;
  threatEngine: false | { state: ThreatEngineState };
  rbac: boolean;
  callerRole?: import("../rbac.js").Role;
  callContext: import("../tool-execution/context.js").CallContext;
  runId?: string;
}

export interface ExactDelegatedRuntimeDescriptor {
  kind: "delegated-op";
  adapter: "provider-exact";
  provider: import("../providers/provider-ids.js").ProviderId;
  credentialProvider: import("../providers/provider-ids.js").ProviderId;
  authSource: CredentialSource;
  model: string;
  runtime: DelegatedProviderRuntime;
  target: DelegatedRuntimeTarget;
  capabilitySnapshot?: PersistedTargetCapabilitySnapshot;
  sessionId?: string;
  surface?: DelegatedRuntimeSurface;
  integrity: { scheme: "hmac-sha256-v1"; mac: string };
}

/** Persisted before exact provider/model rehydration existed. These rows may
 * continue in-process when their live registration exists, but restart
 * recovery deliberately fails closed instead of guessing current settings. */
export interface LegacyDelegatedRuntimeDescriptor {
  kind: "delegated-op";
  adapter: "lane-default" | "codex";
  sessionId?: string;
}

export type DelegatedRuntimeDescriptor = ExactDelegatedRuntimeDescriptor | LegacyDelegatedRuntimeDescriptor;

export type OpRuntimeDescriptor = AppBuildRuntimeDescriptor | DelegatedRuntimeDescriptor;

export interface Op {
  id: string;
  /** Durable originating conversation binding for read-side projections/recovery. */
  sessionId?: string;
  type: string;                           // "build_app" | "research" | "self_edit" | freeform
  task: string;                           // user-facing one-line description
  contextPack: ContextPack;
  lane: OpLane;
  retryPolicy: OpRetryPolicy;
  runtimeDescriptor?: OpRuntimeDescriptor;
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
  /**
   * For app_build ops: the deterministic preview URL. Lets the completion
   * observer surface an "Open" link from the op itself, instead of parsing an
   * APP_READY marker out of model output — which the in-canonical build path
   * (the provider model owns the final message) doesn't reliably emit, so
   * grok-built apps never got a link while the cli-subprocess path did.
   * Stamped at creation with the flat /index.html guess; a "done" terminal
   * commit adopts the adapter's finalized URL (framework builds resolve to
   * the /apps/<name>/ dev-server proxy) — see commitTurn in
   * canonical-loop/checkpoint.ts.
   */
  appUrl?: string;
  lastFailureReason?: string;
  lastFailureAt?: string;
  /**
   * Spawn lineage: the id of the op whose agent submitted THIS op via
   * op_submit / op_submit_async (the spawning turn). Distinct from `dependsOn`
   * below — that's a DAG dependency edge, this is a parent→child spawn edge.
   * Set at submit time from the executor-stamped session's live interactive-host
   * op (see ops/tools/shared.ts resolveParentOpId). Strictly optional: absent
   * when the spawner can't be identified at the submit seam, and on every op
   * created before this field existed.
   */
  parentOpId?: string;
  /** Durable canonical-op prerequisite ids. The scheduler consumes no worker
   * capacity until every prerequisite succeeds. */
  dependsOn?: string[];
  // Reserved for later steps:
  outputContract?: string[];
  inputBindings?: Record<string, string>;
  resourceLocks?: string[];
  /**
   * Additive canonical-loop fields (PRD §9). Optional for persisted operations
   * created before Issue 01; canonical-loop is the sole writer for current ops.
   * See src/canonical-loop/types.ts for the full shape.
   */
  canonical?: import("../canonical-loop/public/op-facts.js").CanonicalOpFields;
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
