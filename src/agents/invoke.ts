/**
 * Canonical invocation entrypoint.
 *
 * Today, code that wants to start an agent reaches for one of several
 * doors: Handler.spawnAgent directly, the agency orchestrator, the
 * agent_spawn tool, the delegate tool, the CEO heartbeat... Each
 * resolves "what is this agent" differently — by role string, by
 * template id, by ad-hoc systemPrompt + tools.
 *
 * invokeAgent() is the ONE function callers should use going forward.
 * It accepts a canonical id (template id or "builtin-<role>") or a
 * role slug, resolves it via AgentCatalog, and dispatches to
 * Handler.spawnAgent with the resolved definition.
 *
 * Returning a RunRef rather than a bare string keeps the door open
 * for queued/deferred invocations later (e.g. "I want to invoke this
 * agent, but block on a budget check first") without an API break.
 */

import type { AgentDefinition, InvokeOpts, RunRef } from "./types.js";
import { AgentCatalog } from "./catalog.js";
import { Handler } from "../agency/handler.js";
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
  const def = AgentCatalog.getInstance().get(idOrRole);
  if (!def) throw new AgentNotFoundError(idOrRole);
  return invokeDefinition(def, task, opts);
}

/**
 * Spawn an agent run from an already-resolved definition. Use this
 * when the caller is passing through an AgentDefinition it built
 * inline (e.g. a one-off ad-hoc agent with no catalog entry).
 *
 * Prefer invokeAgent(id, ...) over this when the agent IS in the
 * catalog — keeps the catalog the source of truth.
 */
export function invokeDefinition(
  def: AgentDefinition,
  task: string,
  opts: InvokeOpts = {},
): RunRef {
  const tools = capTools(def.allowedTools, opts.toolOverride);
  const systemPrompt = def.persona
    ? `${def.systemPrompt}\n\n## Persona\n\n${def.persona}`
    : def.systemPrompt;

  const fieldAgentId = Handler.getInstance().spawnAgent({
    name: opts.nameOverride ?? def.name,
    role: def.role,
    task,
    systemPrompt,
    tools,
    parentSessionId: opts.parentSessionId,
    parentAgentId: opts.parentAgentId,
    templateId: def.id.startsWith("tpl-") ? def.id : undefined,
  });

  logger.info(`[invoke] ${def.role} "${def.name}" id=${def.id} run=${fieldAgentId}`);

  return {
    runId: fieldAgentId,
    fieldAgentId,
    definition: def,
  };
}

/**
 * Apply a tool override. Override must be a SUBSET of the definition's
 * allowedTools — broader requests are silently capped to the
 * definition's surface so a caller can't escalate privileges by
 * asking for tools the role wasn't designed to use.
 */
function capTools(allowed: string[], override: string[] | undefined): string[] {
  if (!override) return [...allowed];
  const allowedSet = new Set(allowed);
  const out = override.filter((t) => allowedSet.has(t));
  if (out.length < override.length) {
    const dropped = override.filter((t) => !allowedSet.has(t));
    logger.warn(`[invoke] tool override dropped (not in definition.allowedTools): ${dropped.join(", ")}`);
  }
  return out;
}
