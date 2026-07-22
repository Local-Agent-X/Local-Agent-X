import type { ContextPack, OpLane } from "../../ops/types.js";
import type { AgentOptions } from "../../providers/types.js";
import type { CallContext } from "../../tool-execution/context.js";
import type { RenderedPromptSection } from "../../context/system-prompt-builder.js";
import type { LocalModelCapabilityProfile } from "../../local-runtimes/index.js";

export interface CanonicalAgentOptions extends AgentOptions {
  /** Caller-declared exact provider/model pin, distinct from a resolved default. */
  targetPin?: ContextPack["routing"]["targetPin"];
  /** Exact ordered model-visible prompt plan. Every caller must classify its
   * content explicitly so local degradation never guesses from telemetry. */
  renderedPromptSections: RenderedPromptSection[];
  /** Filled from the exact resolved local endpoint during preflight. */
  localModelCapabilityProfile?: LocalModelCapabilityProfile | null;
  /** Interactive surfaces such as voice may use Anthropic's direct HTTP OAuth
   * transport, matching chat. Background agents omit this and stay on the CLI. */
  preferAnthropicDirectHttp?: boolean;
  /** Trusted dispatch origin. Omitted non-chat callers default to API. */
  callContext?: CallContext;
  /** Op-level wall-clock ceiling. Replaces caller-side setTimeout-driven
   *  AbortControllers — when this fires, the runner calls opCancel so
   *  canonical's state machine sees a clean running → cancelling → cancelled
   *  transition. Defaults to 15 min if omitted. */
  wallClockMs?: number;
  /** Canonical op type tag (drives retry policy + soak metrics buckets).
   *  Defaults to "agent_turn". Bucket-specific values: "autopilot_round",
   *  "scheduled_mission", "memory_consolidation". */
  opType?: string;
  /** Canonical lane. Defaults to "background" — non-chat callers don't
   *  share the `interactive` cap with live chat turns. */
  lane?: OpLane;
  /** FieldAgent run id from invokeDefinition. Threaded through to the
   *  tool-execution context so per-run activity traces correlate with the
   *  AgentRunStore record. Absent for callers that aren't an agent spawn
   *  (e.g. cron missions, memory consolidation). */
  runId?: string;
  /** True when the userMessage is harness-composed, not user-typed (auto-build
   *  chunk workers). Stamped as op.taskProvenance="harness" so the
   *  instruction-ledger middleware never extracts constraints from it. */
  harnessAuthoredTask?: boolean;
}

export const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;
