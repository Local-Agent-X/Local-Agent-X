/**
 * Agent run runtime — the canonical-loop-backed driver invokeAgent rides on.
 *
 * invoke.ts owns the spawn surface and drives a single registered
 * `AgentRunDriver`; the canonical-loop op record is the recoverable source
 * of truth. Handler keeps a thin FieldAgent in its map for status / cancel
 * / message tools, but the *run* is canonical's.
 *
 * The driver registration indirection avoids an `src → server` import
 * cycle: `server/handler-events.ts` (which owns config, secrets, security,
 * tool policy, project rosters, worktree creation, and the
 * `runAgentViaCanonical` import) registers a driver function during init.
 * `invoke.ts` resolves it lazily at dispatch time. Tests register a stub.
 */

import type { AgentModelPin } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agents.runtime");

/** The request the driver receives — already-resolved everything needed to
 *  run the canonical op. */
export interface AgentRunDriverRequest {
  /** Stable run id minted by invokeDefinition. Matches the FieldAgent.id in
   *  Handler's in-memory map so legacy status/cancel tools can look it up. */
  agentId: string;
  name: string;
  role: string;
  task: string;
  systemPrompt: string;
  /** Allowed tool names from the agent's definition (post project-gate +
   *  override cap). The driver still applies audience-based resolution on
   *  top of this; see resolveToolsForRequest in server/handler-events.ts. */
  tools: string[];
  parentSessionId?: string;
  parentAgentId?: string;
  /** Override for the run's session id. When set, the driver uses this as
   *  the session feeding tool calls instead of `agent-<agentId>`, so an
   *  operation's phases can share session-scoped browser state. */
  sessionId?: string;
  templateId?: string;
  /** Resolved provider+model pin for this run. Set by invokeDefinition
   *  when resolveAgentModel finds a value at any rung (run override,
   *  roster, template default). When undefined, the driver falls back
   *  to the global default via resolveProvider's normal chain. */
  modelOverride?: AgentModelPin;
}

/** What the driver returns when the canonical op reaches a terminal state. */
export interface AgentRunDriverResult {
  result: string;
  success: boolean;
  tokens?: number;
}

export type AgentRunDriver = (
  req: AgentRunDriverRequest,
  signal: AbortSignal,
) => Promise<AgentRunDriverResult>;

let activeDriver: AgentRunDriver | null = null;

export function registerAgentRunDriver(driver: AgentRunDriver): void {
  if (activeDriver) {
    logger.warn("[runtime] replacing existing agent-run driver");
  }
  activeDriver = driver;
}

export function getAgentRunDriver(): AgentRunDriver | null {
  return activeDriver;
}

/** Test-only — drop the registered driver so each test boots from scratch. */
export function _resetAgentRunDriverForTest(): void {
  activeDriver = null;
}

/**
 * Run an agent via the registered canonical-loop driver.
 *
 * Throws if no driver has been registered. The thrown error is the caller's
 * responsibility to surface — `invokeDefinition` catches it and emits a
 * `handler:agent-result` with success: false so subscribers (chunk-runner,
 * AgentRunStore persistence) see the terminal state.
 */
export async function dispatchAgentRun(
  req: AgentRunDriverRequest,
  signal: AbortSignal,
): Promise<AgentRunDriverResult> {
  if (!activeDriver) {
    throw new Error(
      "agents/runtime: no agent-run driver registered. Server init must call " +
      "registerAgentRunDriver() before any invokeAgent call lands. Tests must " +
      "stub the driver before exercising invokeDefinition.",
    );
  }
  return activeDriver(req, signal);
}
