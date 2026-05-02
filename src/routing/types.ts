/**
 * Routing module types — single source of truth for what a routing
 * decision looks like + the decision-log entry shape that persists.
 *
 * Why this lives in its own file: every other routing file (regex-rules,
 * llm-classifier, decision-log, router) imports these. Keeping them
 * separate avoids circular imports and lets each file stay focused.
 */

/** Where the message should run. */
export type RouteDestination = "inline" | "delegate";

/** Result of a routing decision. */
export interface RouteDecision {
  destination: RouteDestination;
  /** Short rule id for telemetry (e.g. "discuss-prefix", "build-noun-phrase", "LLM-veto"). */
  reason: string;
  /** Word count of the message (caller may use for further routing logic). */
  wordCount: number;
}

/** Single entry in the persisted decision log. */
export interface AutoDelegateLogEntry {
  ts: number;
  delegate: boolean;
  reason: string;
  provider: string;
  wordCount: number;
  messagePreview: string;
  /** Full message — needed for the "Stay inline" path to re-submit with /discuss. */
  message?: string;
  /** Set after delegateMessageToWorker returns; lets the UI find this entry by op id. */
  opId?: string;
  /** True if user clicked "Stay inline" — the canonical false-positive signal. */
  userOverride?: boolean;
}

/** Result returned by the LLM classifier (model-as-classifier veto path). */
export interface ClassifierResult {
  inline: boolean;
  reason: string;
  raw: string;
}
