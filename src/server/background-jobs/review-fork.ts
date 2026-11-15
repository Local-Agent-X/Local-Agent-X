/**
 * One background review fork: a canonical run on the background lane with its
 * own static prompt and a hand-picked tool list, under the only real ceiling
 * such a run has. Shared by the two reviews that fork this way, the post-turn
 * skill review (skill-review.ts) and the failure review (failure-review.ts),
 * so the timeout and the failed-run rule exist once.
 *
 * Shape follows dream-check.ts: runAgentViaCanonical on lane "background", a
 * synthetic sessionId, no FieldAgent and no AgentRunStore row.
 */
import { type AgentOptions } from "../../providers/types.js";
import { runAgentViaCanonical } from "../../canonical-loop/index.js";
import { renderPromptSection } from "../../context/system-prompt-builder.js";
import { SecurityLayer } from "../../security/index.js";
import type { AgentTurn, LAXConfig, ToolDefinition } from "../../types.js";
import type { SecretsStore } from "../../secrets.js";
import type { ToolPolicy } from "../../tool-policy/index.js";
import { localProviderDecision } from "../../local-only-policy.js";

/**
 * Wall-clock ceiling per review, enforced HERE because canonical's is not
 * enforced for us.
 *
 * `options.wallClockMs` lands on the op's budget, but worker.ts arms the
 * deadline timer only for `op.lane === "interactive"`, so on the background
 * lane `deadlineExceeded` can never be set. `maxIterations` is no better: the
 * worker's `continuing = op.lane !== "interactive"` makes a background op emit
 * an `iteration_checkpoint`, reset its counter, and keep going — the value is a
 * logging cadence, not a cap. And a middleware `suspend` parks the op in
 * `paused`, which is not a terminal state, so `runAgentViaCanonical`'s
 * `while (terminal === null)` would never resolve and the pass would hang for
 * the life of the process.
 *
 * One timeout closes all three: it aborts the signal (which canonical routes to
 * opCancel, so the op actually stops rather than being merely abandoned) and it
 * resolves the pass either way. Without it a review runs the MAIN model with no
 * turn ceiling and no clock — which is not the trade P1 made.
 *
 * The lane-scoped wall clock in worker.ts is a repo-wide defect owned
 * elsewhere; this is the fix that fits inside these jobs' footprint.
 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

export interface ReviewForkDeps {
  config: LAXConfig;
  dataDir: string;
  secretsStore: SecretsStore;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
}

export interface ReviewForkRequest {
  /** The synthetic session the fork runs under. */
  forkSessionId: string;
  /** The user-turn payload: the evidence under review, fenced as data. */
  message: string;
  systemPrompt: string;
  /** The static prompt section's id and label. */
  section: { id: string; label: string };
  tools: ToolDefinition[];
  opType: string;
  maxIterations: number;
  timeoutMs: number;
  /** Run on a model on this machine only (a user's privacy choice, e.g. mail
   *  triage). The fork then runs on the local provider, `localModel` when
   *  given, and throws LocalModelUnavailableError rather than reach a cloud
   *  model when none is usable. */
  localOnly?: { localModel?: string };
}

/** A local-only fork found no usable local model. Never falls back to cloud. */
export class LocalModelUnavailableError extends Error {
  constructor(reason: string) {
    super(`no local model is available: ${reason}`);
    this.name = "LocalModelUnavailableError";
  }
}

/**
 * Run one fork to a terminal state on the user's main model and return the
 * turn. Throws when the ceiling is hit; a run that resolved may still have
 * failed, which reviewFailure says.
 *
 * MAIN model, not a cheap tier: what a review writes is something a later run
 * will follow, a judgement task, and a bad one is worse than none. Cost is
 * bounded by the idle gate, each job's batch cap, and a static prompt + static
 * tool list that shares the provider's 5-minute prefix cache across forks.
 */
export async function runReviewFork(request: ReviewForkRequest, deps: ReviewForkDeps): Promise<AgentTurn> {
  const { resolveProvider } = await import("../../agent-request/index.js");
  const pinned = request.localOnly;
  const { provider, apiKey, model, customBaseURL } = await resolveProvider(
    deps.config, deps.secretsStore, deps.dataDir,
    pinned ? "local" : undefined, pinned?.localModel || undefined,
  );
  if (pinned) {
    // Judged as strict local-only mode judges a provider, whatever the user's
    // own mode: resolveProvider falls back to a credentialed cloud provider
    // when the local one is not set up, and that is exactly what was refused.
    const local = localProviderDecision(provider, { localOnlyMode: true, ollamaUrl: deps.config.ollamaUrl }, customBaseURL);
    if (!local.allowed) throw new LocalModelUnavailableError(`resolved to "${provider}"`);
  }

  // The only real ceiling this job has — see DEFAULT_REVIEW_TIMEOUT_MS. Abort
  // fires opCancel through canonical so the op genuinely stops; the race
  // guarantees the pass resolves even if the op parks in a non-terminal state.
  const abort = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { timedOut = true; abort.abort(); resolve("timeout"); }, request.timeoutMs);
  });

  const run = runAgentViaCanonical(request.message, [], {
    apiKey,
    model,
    provider: provider as AgentOptions["provider"],
    systemPrompt: request.systemPrompt,
    renderedPromptSections: [renderPromptSection({
      id: request.section.id,
      label: request.section.label,
      type: "static",
      policy: "required",
      text: request.systemPrompt,
    })],
    tools: request.tools,
    security: deps.security,
    toolPolicy: deps.toolPolicy,
    sessionId: request.forkSessionId,
    signal: abort.signal,
    // Both of these are honoured only on the interactive lane; kept because
    // maxIterations still drives checkpoint cadence and wallClockMs is the
    // right declared budget if the worker's lane gate is ever fixed. Neither
    // is load-bearing — the timeout above is.
    maxIterations: request.maxIterations,
    wallClockMs: request.timeoutMs,
    temperature: 0.3,
    callContext: "delegated",
    opType: request.opType,
    lane: "background",
    // The evidence is machine-composed, not user-typed — the
    // instruction-ledger middleware must not mine constraints out of it.
    harnessAuthoredTask: true,
  });

  let outcome: Awaited<typeof run> | "timeout";
  try {
    outcome = await Promise.race([run, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut || outcome === "timeout") {
    // Don't let the abandoned run reject unhandled once it unwinds.
    void run.catch(() => { /* already accounted for as a timeout */ });
    throw new Error(`review exceeded ${request.timeoutMs}ms and was cancelled`);
  }
  return outcome;
}

/** Longest slice of the op's error message the failure line carries. Middleware
 *  abort messages are model-facing nudge paragraphs; mirrors event-pump's cap. */
const FAILURE_MESSAGE_MAX = 240;

/**
 * Why a resolved run is still a failed review, or null when it succeeded.
 *
 * `runAgentViaCanonical` resolves on ANY terminal state — `failed` (a
 * middleware abort such as repeat-output / loop-detection / thrash-guard, an
 * exhausted adapter, a worker exception) and `cancelled` included — and folds
 * the terminal into `stopReason` (agent-runner/collect-result.ts mapStopReason:
 * succeeded→end_turn, cancelled→abort, failed→error; the fold is injective, so
 * the terminal is recovered here without touching the runner). The fold also
 * maps a `failed` carrying error code `max_turns_exceeded` to `max_iterations`,
 * but nothing in src/ emits that code today — the branch below is defensive
 * (a failed terminal by construction), not a path a review can currently hit.
 * When the loop emitted an `error` event the runner also returns it as
 * `errorMessage` = `<code>: <message>` — for a middleware abort that is
 * `middleware-abort: <the middleware's message>`, the closest the seam gets to
 * the abort reason. The op id itself is not returned; the fork session id is
 * unique per review and is what the runner logs the op id against.
 *
 * Before this check a run that resolved at all counted as reviewed, so a night
 * of middleware-aborted ops (every one `failed`, idle-nudge saying "hit a
 * snag") logged `pass: reviewed=1 failed=0`.
 */
export function reviewFailure(outcome: AgentTurn): string | null {
  if (outcome.stopReason === "abort") return "ended cancelled (stopReason=abort)";
  if (outcome.stopReason === "error" || outcome.stopReason === "max_iterations") {
    const detail = outcome.errorMessage ? `: ${outcome.errorMessage.slice(0, FAILURE_MESSAGE_MAX)}` : "";
    return `ended failed (stopReason=${outcome.stopReason}${detail})`;
  }
  return null;
}

/** The fork's final words. Shape-tolerant: content is a string or text parts. */
export function forkReply(outcome: AgentTurn): string {
  for (let i = outcome.messages.length - 1; i >= 0; i--) {
    const message = outcome.messages[i];
    if (message.role !== "assistant") continue;
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content) ? content.map((part) => (part as { text?: unknown }).text).filter((t) => typeof t === "string").join("") : "";
    if (text.trim()) return text;
  }
  return "";
}
