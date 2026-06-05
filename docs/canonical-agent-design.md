# Canonical Agent System — Design

Reference doc for the canonical agent layer. Captures the six load-bearing
decisions made before the implementation phase started, and the build order
that follows from them. Don't change the decisions here without raising it.

---

## The model

Four concepts. Each has one responsibility. They don't overlap.

- **Main Agent** — the user's persistent assistant. One per user. Named by the
  user (default: Primal, but any name). Has its own customizable prompt,
  memory, persona. Lives in its own home (NOT the catalog). The user talks to
  it; it invokes specialists.
- **Agent** (`AgentDefinition`) — a specialist definition: role, system
  prompt, allowed tools, icon, description. Reusable. No org metadata. No
  lifecycle state.
- **Project** — a scoped container. Holds chats, a roster of agents, optional
  tool restrictions, optional budget. Lightweight by default (a Project with
  no roster is just a chat folder); becomes an "organization" naturally as
  agents get hired in. **One concept. The agents-page UI label "Organization"
  is being renamed to "Project" to remove the parallel naming.**
- **Run** — one execution of a definition on a task. Triggered by the main
  agent, by another agent (delegation), by a schedule, or by an explicit
  user action. Persisted via `AgentRunStore`.

### Catalog

`AgentCatalog` is the single source of truth for `AgentDefinition`. It merges
the two legacy sources (built-in roles in `src/agency/agent-roles.ts` +
templates in `AgentTemplateStore`) with deterministic dedup rules: templates
win on id collision; role-only entries get synthesized with stable ids
(`builtin-<role>`).

Lookup: by canonical id (`builtin-researcher`, `tpl-<rand>`) OR by role slug
(`researcher`). Both forms must work during the legacy migration.

### Scope

The catalog and the invoke layer accept an optional `scope: { projectId }`.

- **No scope** → main agent in a default chat. Full catalog.
- **Scope set** → agents running inside a project. Tool surface intersected
  with the project's `allowedTools`. Empty/undefined `allowedTools` means "no
  project-level restriction" — agents keep their definition's full surface.

Scope filters the **display** view, not access. Projects are an
*organizational* grouping, not a hard permission boundary:

- **Display (`AgentCatalog.list(scope)`, behind `agent_list`)** — filtered to
  the project's roster. This is "your team here" + the org chart. A
  missing/unknown project or an empty roster yields an empty team cleanly (no
  throw, no hard error).
- **Resolve-to-spawn (`AgentCatalog.get(idOrRole, scope)`, behind
  `invokeAgent`/`agent_spawn`)** — tries the scoped roster first, then **falls
  back to the full unscoped catalog** when the scoped lookup is empty because
  the project is missing/unknown (e.g. a stale `project_id`), the roster is
  empty (a brand-new project bootstrapping its CEO), or the requested agent
  isn't on the roster. Resolution only fails when the id/role matches nothing
  in the entire catalog. The roster is for the display view + org chart, not
  access control, so a stale or empty scope degrades gracefully instead of
  producing "no matching definition" → repeated failures → circuit breaker.

### Invocation

One function: `invokeAgent(idOrRole, task, opts)`. Wraps
`Handler.spawnAgent`. Resolves through catalog. Applies scope filter, tool
override cap, project tool gate. Returns a `RunRef`.

Escape hatch: `invokeDefinition(def, task, opts)` for callers passing a
synthesized definition (test fixtures, etc.). Internal only — not exposed
to the main agent as a tool.

---

## The six locked decisions

### Q1: How does the main agent invoke?

**One tool, canonical id only. No ad-hoc inline spawn.**

The existing `agent_spawn` tool is refactored to accept
`{ agent: <canonical id or role>, task, opts? }`. The previous
`{ name, role, systemPrompt, tools, task }` ad-hoc shape is killed — the main
agent can no longer compose anonymous workers. Every spawn resolves through
the catalog.

Three primitives total for any delegating agent:

- `agent_list()` — what's on my team (scope-filtered catalog)
- `agent_spawn(agent, task, opts?)` — invoke from the catalog
- `agent_create(...)` — extend the catalog (only in `allowedTools` for the
  main agent at global scope, and CEO at project scope, by default)

Workers without `agent_create` in their tools hit a "missing role" blocker and
report it up the chain via their structured run report. The parent (CEO) reads
the report and decides: add an existing agent, create a project-private one,
or escalate to the user.

### Q2: Streaming vs silent for delegations

**Three surfaces, distinct responsibilities.**

- **Chat** — main agent's voice. It announces delegation in language ("I've
  put the Researcher on this, back in a few minutes…") and posts results
  inline when runs finish. No new UI primitive in the chat.
- **Agents tab — per-agent view (existing)** — drill into one agent, see
  thoughts + tools streaming. Stays as-is.
- **Agents tab — agent history page (new)** — bird's-eye list of every run,
  live + historical. Reads from `AgentRunStore` (already persists everything).
  Live runs appear here and in the sidebar; once done, they disappear from
  sidebar but stay in history forever.

### Q3: Project context

**Persistent sidebar Projects with nested chats. Single concept ("Project").**

The sidebar's `PROJECTS` section becomes functional. Each project is
expandable; its chats are nested under it. Creating a chat inside a project
inherits that project's `id` as the chat's scope. The active chat's
`projectId` (nullable) drives the main agent's catalog scope.

Chats outside any project go in the existing `CONVERSATIONS` bucket. The main
agent there sees the full catalog (no scope).

**"Organization" → "Project" everywhere.** The agents-page label currently
reading "Organization" is being relabeled to "Project". One unit of scoping;
no parallel naming.

### Q4: Hire/fire target

**Hire is always a Project action.** No global "hired" state.

- `AgentDefinition` has no `hired` field. A definition is just "this agent
  exists in the catalog."
- `Project.agentIds` IS the roster — the only place hiring exists.
- Browsing the catalog without a project context → "View / Edit / Fork." No
  hire button.
- Browsing inside a project → "Hire to this Project." Adds to `agentIds`.
  Fire = remove.

Project-keyed org metadata (`reportsTo`, `heartbeatSchedule`, `budget`) moves
to a new store (`~/.lax/project-rosters.json`) keyed by
`(projectId, agentId)`. Same agent in two projects → two roster entries with
independent metadata.

The legacy `AgentTemplate.hired` field is dead. Deleted in the persistence
split diff (L3 below).

### Q5: Approvals

**Delete the dead code. Don't ship approvals as a feature yet.**

`Issue.needsApproval`, `approvalType`, `approvalData` have no producers and
no consumers today. They contradict the "self-running businesses" vision —
approval gates are friction by default. Remove the fields, the UI states
that render them, and the CEO prompt section that references them.

When approvals ARE needed later, they belong as **tool-call permissions**
(declarative `requiresApproval: (args) => boolean` on `ToolDefinition`),
NOT issue-level workflows. The Handler's `pauseSignal` primitive already
exists for the runtime pause/wait pattern.

Real approval cases all map to tool-call-level concerns:

- Spend cap → enforced at invoke time (a limit, not a gate)
- External communications → tool-call permission on `send_email` etc.
- Destructive actions → tool-call permission on `bash`, file deletions, etc.

### Q6: Main agent in the catalog?

**No. Main agent is its own concept, separate from the catalog.**

- Catalog = specialists. Many. Reusable. Role-shaped.
- Main agent = the user's persistent interface. One per user. Personal name,
  memory, soul, persona. Lives in whatever home it already has — NOT in the
  catalog.

Main agent doesn't appear in agent lists, doesn't get a roster entry, doesn't
sit in the org chart. It's the user's interface to the org, not a node in it.

When the main agent delegates, it invokes from the catalog. Inside a project,
the CEO of that project is just another agent on the roster — the main agent
invokes it like any other specialist.

Future: multiple main-agent profiles ("Work Primal" vs "Casual Primal") live
in the main-agent system, not the catalog.

---

## Build order (layered, sequential)

Each layer is its own diff or set of small diffs. Don't try to ship multiple
layers at once.

### L0 — Locked-decision cleanup (pre-work, small)

- **Q3 rename:** "Organization" → "Project" in the agents-page UI strings.
  Pure label change. Code already uses `Project`.
- **Q5 cleanup:** delete `Issue.needsApproval`, `approvalType`,
  `approvalData`, the UI states rendering them, and the CEO prompt section
  about approvals.

### L1 — Definitions (done)

- `AgentDefinition`, `OrganizationMember` (type only), `InvokeScope`,
  `InvokeOpts`, `RunRef` — shipped in 8e519d6.
- `AgentCatalog.list/get` with merge + scope — shipped in 80b5c62.
- `invokeAgent` / `invokeDefinition` with tool gate — shipped.

### L2 — First production consumer (next)

Pick ONE call site and route it through `invokeAgent`. Recommendation: refactor
the `agent_spawn` tool per Q1 (canonical id, no ad-hoc shape). High signal,
proves the canonical layer is real outside unit tests.

Also: introduce the `agent_list` and `agent_create` tools at this layer. They
join `agent_spawn` as the three primitives for any delegating agent.

### L3 — OrganizationMember persistence split

Move org metadata (`hired`, `reportsTo`, `heartbeatSchedule`, `budget`) off
`AgentTemplate` into `~/.lax/project-rosters.json` keyed by
`(projectId, agentId)`. `AgentTemplate` loses those fields. The agents page
hire/fire flow reads/writes the new store via Project APIs.

### L4 — Unified Run type

Wrap `FieldAgent` (in-flight) + `AgentRun` (persisted) under a single canonical
`Run` interface. Document the state machine. Unblocks the UI run viewer.

### L5 — Consumer migration sweep

`agency_list_roles`, `agent_wakeup`, the Agency orchestrator's planner, the
CEO heartbeat. All read from the catalog and dispatch through `invokeAgent`.

### L6 — UI redesign

Agents page driven by `AgentCatalog.list()`. Project view with scoped roster.
Agent history page (Q2). Sidebar Projects with nested chats (Q3). Hire/fire
that mutates the roster store (Q4). Org chart that routes delegation.

### L7 — Cross-cutting

Heartbeats invoke through canonical. Budgets enforced at invoke time. Tool-call
permissions for approvals (Q5).

### L8 — Deletion

Remove `BUILT_IN_ROLES` / `customRoles` once `agency_list_roles` migrates.
Remove `_seedBuiltinRoles` once nothing reads it. Remove legacy
ad-hoc-spawn paths once `agent_spawn` is canonical-only.

---

## Open work (cross-cutting hygiene)

- The two pre-existing vitest flakes (`canonical-loop-08-lease-and-crash-recovery`
  and `primal-loop`) fail under heavy parallel load but pass in isolation.
  Not blocking; flag for the test infra owner.
- The `~/.lax/mcp.json` filesystem path was fixed locally (Manri legacy);
  not a code change because new installs already get `${HOME}` defaults.

---

## What this doc is NOT

- A recap of the conversation that produced these decisions.
- A migration plan for legacy data (each layer owns its migration).
- A list of UI changes (L6 is its own design pass).
- Permission to skip the build order. Don't ship L6 before L3.
