/**
 * Canonical invocation entrypoint — single door for "start an agent run."
 *
 * Today every other spawn door has either been retired (operations/executor,
 * routes/agents template spawn) or routed through here (agent_spawn tool,
 * delegate tool, primal-auto-build chunk worker). After F1 closes, this
 * function is also where canonical-loop persistence kicks in: every run
 * lands in `~/.lax/operations/<opId>/events.jsonl` and is recoverable, not
 * just chat turns.
 *
 * Flow:
 *   1. Resolve the AgentDefinition (catalog lookup; org/project scoping).
 *   2. Cap tools through the project gate + caller's override.
 *   3. Attach a FieldAgent record in Handler's registry so the legacy
 *      status / cancel / message tools still find the run by id.
 *   4. Emit `handler:agent-spawn` so `server/handler-events.ts`'s UI
 *      broadcaster + pendingMeta capture for AgentRunStore fire.
 *   5. Hand the request to the registered canonical-loop driver
 *      (`agents/runtime.ts`). The driver runs `runAgentViaCanonical`,
 *      producing the persisted op record.
 *   6. When the driver resolves, emit `handler:agent-result` so
 *      chunk-runner.ts, the AgentRunStore subscriber, and the UI
 *      broadcaster observe the terminal state.
 *
 * Returning a RunRef rather than a bare string keeps the door open for
 * queued/deferred invocations later (e.g. budget-checked dispatch) without
 * an API break.
 */

import type { AgentDefinition, AgentModelPin, InvokeOpts, RunRef } from "./types.js";
import { AgentCatalog } from "./catalog.js";
import { Handler } from "../agency/handler.js";
import { ProjectStore } from "../agent-store/index.js";
import { ProjectRosterStore } from "../project-rosters.js";
import { EventBus } from "../event-bus.js";
import { dispatchAgentRun, type AgentRunDriverRequest } from "./runtime.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agents.invoke");

export class AgentNotFoundError extends Error {
  constructor(idOrRole: string) {
    super(`No agent definition found for "${idOrRole}". Check AgentCatalog.list() for available agents.`);
    this.name = "AgentNotFoundError";
  }
}

/**
 * Spawn an agent run from the canonical catalog.
 *
 * @param idOrRole Canonical agent id ("tpl-..." or "builtin-<role>")
 *                 OR a role slug ("researcher"). Catalog resolves both;
 *                 id wins on ambiguity.
 * @param task     The task the agent should perform.
 * @param opts     Optional parent linkage + tool/name overrides.
 * @throws AgentNotFoundError when the id/role doesn't resolve.
 */
export function invokeAgent(
  idOrRole: string,
  task: string,
  opts: InvokeOpts = {},
): RunRef {
  const def = AgentCatalog.getInstance().get(idOrRole, opts.scope);
  if (!def) throw new AgentNotFoundError(idOrRole);
  return invokeDefinition(def, task, opts);
}

/**
 * Spawn an agent run from an already-resolved definition. Use this when
 * the caller is passing through an AgentDefinition it built inline (e.g.
 * a one-off ad-hoc agent with no catalog entry — operations/executor's
 * phase agents do this).
 *
 * Prefer `invokeAgent(id, ...)` when the agent IS in the catalog — keeps
 * the catalog the source of truth.
 */
export function invokeDefinition(
  def: AgentDefinition,
  task: string,
  opts: InvokeOpts = {},
): RunRef {
  const tools = capTools(applyProjectToolGate(def.allowedTools, opts), opts.toolOverride);
  const systemPrompt = def.persona
    ? `${def.systemPrompt}\n\n## Persona\n\n${def.persona}`
    : def.systemPrompt;
  const name = opts.nameOverride ?? def.name;
  const templateId = def.id.startsWith("tpl-") ? def.id : undefined;
  const modelOverride = resolveAgentModel(def, opts);

  const { agentId, abortController } = Handler.getInstance().attachExternalRun({
    name,
    role: def.role,
    task,
    systemPrompt,
    tools,
    parentSessionId: opts.parentSessionId,
    parentAgentId: opts.parentAgentId,
    templateId,
  });

  EventBus.emit("handler:agent-spawn", {
    agentId,
    name,
    role: def.role,
    task,
    systemPrompt: systemPrompt || "",
    parentSessionId: opts.parentSessionId || "",
    parentAgentId: opts.parentAgentId || null,
    templateId: templateId || null,
  });

  logger.info(`[invoke] ${def.role} "${def.name}" id=${def.id} run=${agentId}`);

  void runAgentViaDriver(
    {
      agentId,
      name,
      role: def.role,
      task,
      systemPrompt,
      tools,
      parentSessionId: opts.parentSessionId,
      parentAgentId: opts.parentAgentId,
      sessionId: opts.sessionId,
      templateId,
      modelOverride,
    },
    abortController.signal,
  );

  return {
    runId: agentId,
    definition: def,
  };
}

/**
 * Event-bridge — translates the canonical-loop driver's terminal outcome
 * into the `handler:agent-result` signal. AgentRunStore.save fires on it
 * in `server/handler-events.ts`; chunk-runner.ts and operations/executor.ts
 * also subscribe.
 *
 * Errors that escape the driver (e.g. no driver registered, infrastructure
 * failure) are converted into a failed result here — the FieldAgent
 * transitions cleanly to `failed` and the AgentRunStore record gets
 * written with an error field, instead of silently hanging.
 */
/**
 * Lifecycle verification primitive — confirms a spawned agent run actually
 * reached a non-failed state, or surfaces the init crash reason.
 *
 * Agent runs do NOT flow through the canonical-loop ops table; they live
 * in Handler's FieldAgent registry. attachExternalRun sets status="working"
 * synchronously, so the literal "did the run start?" check is trivially
 * true. The interesting question is the truthful one for callers: did the
 * void-fired runAgentViaDriver crash during init before producing any
 * tokens? finalizeExternalRun flips status to "failed" on driver throw.
 *
 * Resolution order:
 *   1. Agent already terminal → return immediately.
 *   2. Subscribe to handler:agent-result for this runId, race a timeout.
 *      If success:false fires within the window, the spawn failed init.
 *   3. Timeout → assume still running.
 *
 * Symmetry with awaitOpRunning(opId, timeoutMs).
 */
export type AwaitAgentResult = { running: true } | { running: false; reason: string };

export async function awaitAgentRunning(
  runId: string,
  timeoutMs = 5000,
): Promise<AwaitAgentResult> {
  const handler = Handler.getInstance();
  // Read current status — agent may already be terminal (race against fast
  // driver returns).
  try {
    const status = handler.getAgentStatus(runId) as { status: string };
    if (status.status === "failed") return { running: false, reason: "agent run failed during init" };
    if (status.status === "succeeded") return { running: true }; // already finished — counts as having run
  } catch {
    return { running: false, reason: `agent run ${runId} not found` };
  }

  return new Promise<AwaitAgentResult>((resolve) => {
    let settled = false;
    const finish = (r: AwaitAgentResult) => {
      if (settled) return;
      settled = true;
      EventBus.off("handler:agent-result", onResult);
      clearTimeout(timer);
      resolve(r);
    };
    const onResult = (data: unknown) => {
      const d = data as { agentId: string; success: boolean; error?: string };
      if (d.agentId !== runId) return;
      // Terminal during the window — only treat as "did not start" if the
      // outcome was failure. A success this fast means the run did execute,
      // just quickly; we accept it.
      if (d.success) { finish({ running: true }); return; }
      finish({ running: false, reason: d.error || "agent run failed during init" });
    };
    EventBus.on("handler:agent-result", onResult);
    const timer = setTimeout(() => finish({ running: true }), timeoutMs);
    timer.unref?.();
  });
}

async function runAgentViaDriver(req: AgentRunDriverRequest, signal: AbortSignal): Promise<void> {
  const handler = Handler.getInstance();
  let outcome: { result: string; success: boolean; tokens?: number };
  try {
    outcome = await dispatchAgentRun(req, signal);
  } catch (e) {
    outcome = { result: (e as Error).message || String(e), success: false };
  }
  handler.finalizeExternalRun(req.agentId, outcome);

  EventBus.emit("handler:agent-result", {
    agentId: req.agentId,
    result: outcome.result,
    success: outcome.success,
    tokens: outcome.tokens,
    error: outcome.success ? undefined : outcome.result,
  });
}

/**
 * Apply a tool override. Override must be a SUBSET of the allowed surface
 * (already project-gated) — broader requests are silently capped so a
 * caller can't escalate privileges by asking for tools the role wasn't
 * designed to use.
 */
function capTools(allowed: string[], override: string[] | undefined): string[] {
  if (!override) return [...allowed];
  const allowedSet = new Set(allowed);
  const out = override.filter((t) => allowedSet.has(t));
  if (out.length < override.length) {
    const dropped = override.filter((t) => !allowedSet.has(t));
    logger.warn(`[invoke] tool override dropped (not in allowed surface): ${dropped.join(", ")}`);
  }
  return out;
}

/**
 * Intersect the definition's allowedTools with the project's allowedTools
 * when an org scope is set. A project with no allowedTools (undefined or
 * empty array) means "no project-level restriction" — the definition's
 * full surface stands. This keeps org membership opt-in for tool gating;
 * just being in a project doesn't shrink your tools unless the project
 * owner declared an allowlist.
 */
/**
 * Resolve the effective provider+model pin for one invocation.
 *
 * Chain (first hit wins):
 *   1. opts.modelOverride        — per-run pick (delegation tools)
 *   2. roster.model              — per-project override (set via UI/PATCH)
 *   3. def.defaultModel          — template-level default
 *   4. undefined                 — fall through to the global default
 *                                  at resolveProvider time.
 *
 * The roster lookup is gated on opts.scope — agents invoked without a
 * project scope (main chat, headless ops) can't have a per-project
 * override, so we skip the store hit.
 */
export function resolveAgentModel(
  def: AgentDefinition,
  opts: InvokeOpts,
): AgentModelPin | undefined {
  if (opts.modelOverride) return opts.modelOverride;
  if (opts.scope) {
    const roster = ProjectRosterStore.getInstance().get(opts.scope.projectId, def.id);
    if (roster?.model) return roster.model;
  }
  return def.defaultModel;
}

export function applyProjectToolGate(allowed: string[], opts: InvokeOpts): string[] {
  if (!opts.scope) return [...allowed];
  const project = ProjectStore.getInstance().get(opts.scope.projectId);
  if (!project?.allowedTools || project.allowedTools.length === 0) return [...allowed];
  const projectSet = new Set(project.allowedTools);
  const gated = allowed.filter((t) => projectSet.has(t));
  if (gated.length < allowed.length) {
    const dropped = allowed.filter((t) => !projectSet.has(t));
    logger.info(`[invoke] project ${opts.scope.projectId} gate dropped: ${dropped.join(", ")}`);
  }
  return gated;
}
