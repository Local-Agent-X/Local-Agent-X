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
import { ProjectStore } from "../agent-store.js";
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
