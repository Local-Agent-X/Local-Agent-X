/**
 * Canonical agent types — the single anchor both the legacy template
 * store (src/agent-store.ts, "employees") and the legacy role catalog
 * (src/agency/agent-roles.ts, "agency roles") will converge on.
 *
 * Three concepts, deliberately separated where today's code mashes them
 * together:
 *
 *   AgentDefinition  — what an agent IS. Role, prompt, allowed tools,
 *                      icon, description. Reusable. No lifecycle.
 *                      No org metadata. No persistence state.
 *
 *   OrganizationMember — what an agent IS WITHIN AN ORG. Hired flag,
 *                      reportsTo, heartbeat, budget, project membership.
 *                      Today this is mashed into AgentTemplate; the
 *                      canonical layer splits it so future migrations
 *                      can isolate the two.
 *
 *   RunRef           — a single execution. Returned by invokeAgent().
 *                      Already lives in src/agent-store.ts as AgentRun;
 *                      we re-export the shape here so downstream code
 *                      depends on the canonical name, not the file.
 *
 * This module is types-only. The catalog (catalog.ts) is the runtime
 * source of truth; invoke.ts is the single entrypoint to spawn.
 */

/** The canonical "what is an agent" record — pure definition, no state. */
export interface AgentDefinition {
  /** Stable identifier. For built-ins this is "builtin-<role>"; for user
   *  agents it's "tpl-<timestamp>-<rand>" (matches AgentTemplate ID shape
   *  so legacy callers can pass either through). */
  id: string;
  /** Display name (e.g. "Researcher"). */
  name: string;
  /** Short role slug used by orchestrators and the agency planner
   *  (e.g. "researcher", "coder", "ceo"). Multiple definitions MAY share
   *  a role; the catalog dedupes by id, not role. */
  role: string;
  /** Load-bearing prompt the agent runs under. */
  systemPrompt: string;
  /** Tools the agent may call. Names match the registered ToolDefinition
   *  set; unknown tools at spawn time are dropped with a warn. */
  allowedTools: string[];
  /** One-line UI description. Appears in pickers and slash popups. */
  description: string;
  /** Optional emoji/icon for UI rendering. */
  icon?: string;
  /** Optional persona body — extra context appended after systemPrompt,
   *  separated from the role-level prompt so org-specific personas can
   *  layer on without forking the base role. */
  persona?: string;
  /** True = spawn this agent inside an isolated git worktree of the LAX
   *  repo (for source-code edits). Default false. Replaces the legacy
   *  role-string regex (`isCodeRole`) in handler-events.ts. Set true
   *  ONLY when the agent edits LAX itself; leave false for everything
   *  that edits user projects (chunk-runner workers, etc) or operates
   *  in the web/file/shell surface (operator, researcher, browser). */
  requiresWorktree?: boolean;
}

/** Org-level metadata about an agent definition. Lives separately from
 *  AgentDefinition so the "what" and "where in the org" are not coupled. */
export interface OrganizationMember {
  /** Foreign key to AgentDefinition.id. */
  agentId: string;
  /** Active employee vs. just a template the user might hire later. */
  hired: boolean;
  /** ID of the agent this one reports to (drives delegation routing
   *  once the org chart becomes load-bearing). */
  reportsTo?: string;
  /** Project membership — agents are scoped to a project when set. */
  projectId?: string;
  /** Cron-style wake-up schedule. */
  heartbeatSchedule?: string;
  heartbeatEnabled?: boolean;
  /** Monthly spend cap (USD) + ledger. */
  budget?: { maxPerMonth: number; spent: number; resetAt: number };
}

/** Project-scoping for catalog lookups and invocations. When set, the
 *  catalog filters to agents on the project's roster (Project.agentIds)
 *  and the invoke layer intersects the agent's allowedTools with the
 *  project's allowedTools. Absent → full catalog, full tool surface. */
export interface InvokeScope {
  projectId: string;
}

/** Options passed to invokeAgent. */
export interface InvokeOpts {
  /** Parent session — captured at spawn so streams/UI can attribute the
   *  run to the chat that started it. Optional for headless invokes. */
  parentSessionId?: string;
  /** Parent agent — set when an agent spawns a child agent (delegation
   *  chain). Used for the run tree in AgentRunStore. */
  parentAgentId?: string;
  /** Override the definition's allowedTools — narrower than the
   *  definition allows is fine; broader is silently capped. */
  toolOverride?: string[];
  /** Display name override — when the caller wants to name this
   *  particular run (e.g. "Q3 research"). */
  nameOverride?: string;
  /** Org-scope. Main agent (default chat) omits this and sees the full
   *  catalog. Agents running inside a project pass scope so delegation
   *  is gated by the org's roster + tool allowlist. */
  scope?: InvokeScope;
}

/** Handle returned from invokeAgent. Callers poll run status via
 *  AgentRunStore.get(runId) or subscribe to handler events. */
export interface RunRef {
  /** AgentRun.id — opaque, used to look up history. */
  runId: string;
  /** The live FieldAgent id from the Handler. Same string as runId in
   *  the current implementation; kept distinct in the type so a future
   *  separation (e.g. queued runs that haven't spawned yet) doesn't
   *  require an API break. */
  fieldAgentId: string;
  /** The definition that was invoked, post-resolution. Useful for the
   *  caller to confirm which role actually ran (e.g. when the requested
   *  name resolved to a fork or override). */
  definition: AgentDefinition;
}
