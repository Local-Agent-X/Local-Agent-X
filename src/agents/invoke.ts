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
 *   6. When the driver resolves, emit `handler:agent-result` (+ done /
 *      error) so chunk-runner.ts, the AgentRunStore subscriber, and other
 *      legacy EventBus listeners observe the terminal state unchanged.
 *
 * Returning a RunRef rather than a bare string keeps the door open for
 * queued/deferred invocations later (e.g. budget-checked dispatch) without
 * an API break.
 */

import type { AgentDefinition, InvokeOpts, RunRef } from "./types.js";
import { AgentCatalog } from "./catalog.js";
import { Handler } from "../agency/handler.js";
import { ProjectStore } from "../agent-store.js";
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

  // Wall-clock guard. Without this an agent can sit "working" forever if
  // its driver hangs (provider HTTP stall, infinite tool-call loop with
  // no progress, etc.) — the user sees the AGENTS sidebar card stuck on
  // 0-95% with no way to recover except restarting the server. We
  // abort() the same AbortController the driver already respects, so
  // recovery is the existing terminal path (driver throws on signal →
  // runAgentViaDriver converts to a clean failed outcome). Default 30
  // min matches the order of magnitude of MISSION_HARD_TIMEOUT_MS for
  // cron; ops can override via LAX_AGENT_TIMEOUT_MS for long jobs.
  const agentTimeoutMs = Number(process.env.LAX_AGENT_TIMEOUT_MS) || 30 * 60_000;
  const wallClockTimer = setTimeout(() => {
    if (!abortController.signal.aborted) {
      logger.warn(`[invoke] Agent ${agentId} hit ${(agentTimeoutMs / 60000).toFixed(0)}min wall-clock — aborting`);
      try { abortController.abort(); } catch { /* abort is idempotent */ }
    }
  }, agentTimeoutMs);
  // Don't keep the process alive just for this timer.
  if (typeof wallClockTimer.unref === "function") wallClockTimer.unref();

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
      templateId,
    },
    abortController.signal,
  ).finally(() => clearTimeout(wallClockTimer));

  return {
    runId: agentId,
    fieldAgentId: agentId,
    definition: def,
  };
}

/**
 * Event-bridge — translates the canonical-loop driver's terminal outcome
 * into the legacy EventBus signals subscribers expect.
 *
 * `handler:agent-result` is the durable signal — AgentRunStore.save fires
 * on it in `server/handler-events.ts`. `handler:agent-done` and
 * `handler:agent-error` are the chunk-runner / primal-auto-build hooks
 * (see `src/primal-auto-build/agents/chunk-runner.ts`). All three must
 * fire on terminal so existing consumers don't need to learn the new shape.
 *
 * Errors that escape the driver (e.g. no driver registered, infrastructure
 * failure) are converted into a failed result here — the FieldAgent
 * transitions cleanly to `failed` and the AgentRunStore record gets
 * written with an error field, instead of silently hanging.
 */
async function runAgentViaDriver(req: AgentRunDriverRequest, signal: AbortSignal): Promise<void> {
  const handler = Handler.getInstance();
  let outcome: { result: string; success: boolean; tokens?: number };
  try {
    outcome = await dispatchAgentRun(req, signal);
  } catch (e) {
    outcome = { result: (e as Error).message || String(e), success: false };
  }
  handler.finalizeExternalRun(req.agentId, outcome);

  if (outcome.success) {
    EventBus.emit("handler:agent-done", {
      agentId: req.agentId,
      result: outcome.result,
    });
    EventBus.emit("handler:agent-result", {
      agentId: req.agentId,
      result: outcome.result,
      success: true,
      tokens: outcome.tokens,
    });
  } else {
    EventBus.emit("handler:agent-error", {
      agentId: req.agentId,
      error: outcome.result,
    });
    EventBus.emit("handler:agent-result", {
      agentId: req.agentId,
      result: outcome.result,
      success: false,
    });
  }
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
