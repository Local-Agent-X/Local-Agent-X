# Canonical Tool Resolver — Design

**Status:** Design ready for implementation (P1.C2).
**Scope:** AUDIT Cluster 11 consolidation. Replaces five drifting tool-filter sets with one canonical resolver keyed on an explicit audience field.
**Companion:** [AUDIT.md Cluster 11](../AUDIT.md), [AUDIT-PLAN.md P1](../AUDIT-PLAN.md).

---

## Problem

Five sources of truth currently decide "what tools does this model see right now":

| # | Filter | Location | Used by | Status |
|---|---|---|---|---|
| 1 | `EAGER_TOOLS` Set | [registry-build.ts:106](../src/tools/registry-build.ts#L106) | Returned from `buildToolRegistry()`, no live caller | **Orphan** |
| 2 | `CORE_TOOL_NAMES` Set | [tool-filter.ts:7](../src/agent-request/tool-filter.ts#L7) | Main chat per-turn filter | Live |
| 3 | `BUILD_INTENT_TOOLS` Set | [tool-filter.ts:110](../src/agent-request/tool-filter.ts#L110) | Main chat strip-down on build intent | Live |
| 4 | `OPERATOR_TOOLS` Set | [handler-events.ts:79](../src/server/handler-events.ts#L79) | All spawned `FieldAgent`s | Live |
| 5 | `defer` flag on registry entry | [tool-search.ts:18](../src/tool-search.ts#L18) | tool_search visibility, NOT model-visible schema | Live but misleading |

Adding a tool means hunting through 1+2+3+4 (and remembering 5 is decorative). Forgetting one of them is invisible at compile time and only surfaces at runtime as "tool isn't in my loaded schema."

`CORE_AGENT_TOOLS` (#6, was in handler-events.ts) was confirmed dead and deleted in commit `b124023`.

A sibling drift trap rides along: [handler-events.ts:91](../src/server/handler-events.ts#L91) decides "create isolated worktree?" via a regex on the role string (`/\b(developer|engineer|coder|...)\b/`). Same shape as the tool drift — behavior keyed off substring of metadata — and it should be fixed in the same refactor.

## Goals

1. One source of truth: every tool declares which **audiences** it belongs to at registration; one function reads that to produce the per-request tool list.
2. Compile-time visibility: missing an audience tag should be a `tsc` error, not a runtime surprise.
3. No behavior change for existing audiences: every current message → tool list mapping is preserved byte-for-byte.
4. Worktree decision is **explicit per agent definition**, not keyed off a role-string regex.

## Non-goals

- Replacing tool_policy / RBAC. The resolver decides what's *visible* to the model. tool_policy still decides what's *allowed to execute*. Two layers, different concerns.
- Replacing `tool_search` deferred-loading. The `defer` flag stays, but its meaning becomes precise: "not in the eager set for any audience" vs "in the eager set for at least one audience."
- Reworking MCP tool inclusion. MCP tools flow through `bootstrapServices` and continue to be appended to `allAgentTools`. The resolver treats them like any other tool — they'll get audience tags too.

---

## The `Audience` type

```ts
// src/types.ts
export type Audience =
  | "main-chat"          // The top-level user-facing chat session (Primal)
  | "spawned-agent"      // Sub-agents spawned via agent_spawn (default surface)
  | "operator"           // Operations-phase workers (browser + file + memory only)
  | "build-intent";      // Strip-down used when the user message is "build me X"
```

Four audiences, exhaustive. If a future caller needs a different surface (e.g. a voice-mode tool list), add it here and tag the relevant tools. The exhaustive shape lets the compiler check `switch (audience)` covers every case.

The `build-intent` audience is a special case: it's not a *consumer* (no agent class runs with it), it's a **modifier** that narrows `main-chat` when `BUILD_INTENT_REGEX.test(message)` matches. We model it as a real audience to keep the resolver function pure.

---

## `ToolDefinition` extension

```ts
// src/types.ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
  readOnly?: boolean;
  concurrencySafe?: boolean;

  /** Which audiences see this tool in their eager schema. Empty/undefined
   *  means deferred — only loaded via tool_search. Most tools should set
   *  at least one audience; only intentionally-hidden tools (deprecated
   *  surfaces, advanced kebab-cases) should be empty. */
  audiences?: Audience[];
}
```

Adding `audiences?` keeps the field optional so any tool registered without it falls through to the deferred set — no regression for tools that haven't been tagged yet. Migration is incremental.

A separate `requiresWorktree` field is **not** added to `ToolDefinition` — that's an agent-definition concern, not a tool concern. See "Sibling refactor" below.

---

## `resolveToolsForRequest` signature

```ts
// src/tool-search.ts (co-located with ToolRegistry)
export interface ResolveRequest {
  audience: Audience;
  /** User message text. Optional — only used for build-intent strip-down
   *  and literal-tool-call detection in the main-chat audience. */
  message?: string;
}

export function resolveToolsForRequest(
  req: ResolveRequest,
  registry: ToolRegistry,
): ToolDefinition[];
```

### Behavior (deterministic, pure)

1. Start with `eagerForAudience(req.audience)` — every tool whose `audiences` includes `req.audience`.
2. If `req.audience === "main-chat"` AND `req.message` is given:
   - If `BUILD_INTENT_REGEX.test(message)` AND no literal tool-call detected: return the `build-intent` audience's tool list. (Strip-down.)
   - Otherwise: apply keyword routing (`TOOL_KEYWORD_MAP`) — keywords that match the message add their prefix-matched tools to the result.
   - Always: literal tool-call detection (`detectLiteralToolCalls`) force-includes any `tool_name({...})` syntax matches.
3. If `req.audience !== "main-chat"`: return the eager set as-is. Spawned agents don't get keyword routing or build-intent strip-down — they get a fixed tool list based on their definition.
4. Apply per-template restrictions (`template.allowedTools`, when set) as a final intersection. The intersection always preserves the canonical helper tools (`issue_*`, `agent_whoami`, `agent_team_list`, `agent_wakeup`) so a restrictive template doesn't cut off agent identity.

The build-intent path stays a special case rather than becoming a third axis because no real consumer asks for `build-intent` directly — it's always derived from `main-chat` + message inspection. Keeping it inside the `main-chat` branch matches existing semantics.

---

## Audience tagging — migration mapping

The following maps each current filter entry to its new `audiences` tag. Tools appear in multiple audiences when they should be visible in multiple contexts.

### `main-chat` (was `CORE_TOOL_NAMES`)

All 60-ish tools currently in `CORE_TOOL_NAMES` get `audiences: ["main-chat"]` (plus other audiences where appropriate per below). Single source of truth: the `CORE_TOOL_NAMES` Set itself becomes the list of tools tagged with `main-chat`.

### `spawned-agent` (was `OPERATOR_TOOLS` + dynamic template.allowedTools)

```
browser, bash, read, write, edit, http_request,
web_search, web_fetch, view_image, ocr,
memory_search, memory_save, memory_recall,
document_create, document_edit, spreadsheet_read, spreadsheet_write, pdf_create,
email_send, ask_user,
```

Plus the canonical "agent identity" helpers always added by the resolver final-pass:
`issue_create, issue_list, issue_update, issue_search, issue_checkout, issue_release, issue_request_approval, agent_whoami, agent_team_list, agent_wakeup`.

### `operator` (was OPERATOR_TOOLS for `role === "operator"`)

Same list as `spawned-agent` minus the agent-identity tools. (Current code adds the identity tools defensively — operators arguably don't need them. The new resolver makes that explicit: `operator` audience does NOT get the identity intersection.)

### `build-intent` (was `BUILD_INTENT_TOOLS`)

```
build_app, write, edit, read, bash, glob, grep,
web_fetch, web_search, tool_search,
ask_user, view_image, self_edit,
agent_list, agent_spawn, agent_create, agent_status, agent_kill,
```

11-ish tools. Used only when the main-chat resolver detects build-intent and no literal-call override.

### Tools with no audience (deferred)

Anything currently NOT in CORE_TOOL_NAMES / OPERATOR_TOOLS / BUILD_INTENT_TOOLS stays deferred. Loaded on-demand by `tool_search`. The audit's §2.6 dead-code sweep already removed orphan tool files; what's left and unaudienced is fine — those are legitimately specialized tools (e.g. `marketplace_*`, `mission_chain_*`, `voice_visual`).

---

## Sibling refactor: explicit `requiresWorktree` on AgentDefinition

The role-string regex in [handler-events.ts:91](../src/server/handler-events.ts#L91) is the same drift pattern. Fix in the same chunk that migrates `OPERATOR_TOOLS`:

```ts
// src/agents/types.ts (existing AgentDefinition)
export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  allowedTools: string[];
  description: string;
  icon?: string;

  /** Audience for resolveToolsForRequest. Defaults to "spawned-agent". */
  audience?: Audience;

  /** True = create isolated git worktree at spawn. Default false.
   *  Set true on agent definitions that edit LAX source code; leave
   *  false (default) for everything else, including chunk-runner
   *  workers which edit user-project files not LAX. */
  requiresWorktree?: boolean;
}
```

`handler-events.ts` reads `def.requiresWorktree` from the spawn config. The `isCodeRole` regex is **deleted**.

The chunk-runner definition currently has role `"implementer"` (the workaround from commit `4182223`). After this refactor, role can go back to `"coder"` or stay `"implementer"` — it's no longer behavior-bearing for worktree decisions.

---

## Backward-compat shim plan

`filterToolsForMessage` stays exported with the same signature, but its body delegates:

```ts
// src/agent-request/tool-filter.ts (after migration)
export function filterToolsForMessage(
  allTools: ToolDefinition[],
  message: string,
): ToolDefinition[] {
  // Adapter: assume audience="main-chat" for legacy callers.
  return resolveToolsForRequest(
    { audience: "main-chat", message },
    getToolRegistry(),
  );
}
```

External callers (and any test that calls `filterToolsForMessage` directly) keep working. Once every caller is migrated to `resolveToolsForRequest`, this shim can be deleted in P1.C4.

Similarly in handler-events.ts: the `OPERATOR_TOOLS.has(...)` filter becomes:

```ts
const spawnedTools = resolveToolsForRequest(
  { audience: def.audience ?? "spawned-agent" },
  registry,
);
```

The `template.allowedTools` intersection moves inside the resolver as the final pass (per "Behavior" §4 above), so handler-events doesn't repeat the logic.

---

## Risks

| Risk | Mitigation |
|---|---|
| **R1.** Migration produces a different tool list for the same input → silent behavior change | P1.C3's done-when requires byte-identical tool list for 10 representative messages |
| **R2.** Adding `audiences?: Audience[]` to ToolDefinition is a structural type change → MCP tool wrappers may not satisfy it | Field is optional. Unaudienced tools fall through to deferred. No structural break. |
| **R3.** `template.allowedTools` intersection currently lives in handler-events; moving inside resolver could miss the "always add identity helpers" carve-out | The resolver function explicitly tests this. Migration adds it as named behavior, not implicit. |
| **R4.** The `requiresWorktree` flag flip changes which chunk-runner agents get worktrees | Documented in P1.C4 done-when: spawn one chunk-runner-trunk and one builtin-coder, verify the pwd in their first bash call. |
| **R5.** Deferred tools (no audience) become harder to find — tool_search is the only way in | This is the design. The previous state was the same; the registry's `defer` field already gated this. The new model just makes it explicit per-audience instead of binary. |
| **R6.** A tool tagged for `main-chat` but not `spawned-agent` will be hidden from sub-agents that need it | Migration mapping above is comprehensive. The resolver function is small enough to test exhaustively; a missing tag would surface in the 10-message diff test. |

---

## Implementation order

| Chunk | What | Where |
|---|---|---|
| **P1.C1** | This design doc | `docs/tool-resolver-design.md` (done) |
| **P1.C2** | Add `audiences` to ToolDefinition, tag all tools, implement `resolveToolsForRequest`. **No caller changes.** | `src/types.ts`, `src/tool-search.ts`, every tool file |
| **P1.C3** | Migrate `filterToolsForMessage` to delegate to `resolveToolsForRequest`. Keep shim for back-compat. Verify byte-identical tool list for 10 reference messages. | `src/agent-request/tool-filter.ts` |
| **P1.C4** | Migrate handler-events.ts spawned-agent path. Add `requiresWorktree` to AgentDefinition. Delete `isCodeRole` regex. Delete `OPERATOR_TOOLS` set. Delete orphan `EAGER_TOOLS` set. | `src/server/handler-events.ts`, `src/agents/types.ts`, chunk-runner definitions |

Each chunk is independently committable and reviewable. C2 is additive (zero behavior risk). C3 is the migration with the regression guard (10-message diff). C4 deletes the old surface.

---

## What we are NOT changing in P1

- The `defer` flag stays on `ToolRegistry.register`. Semantics: "this tool has no audiences." Deferred = no audience tags.
- `tool_search` ranking. Already fixed in commit `4d50fad`.
- The literal-tool-call detector. Already in place in commit `4182223`. Moves verbatim into the resolver.
- The keyword routing table (`TOOL_KEYWORD_MAP`). Stays inside the main-chat branch of the resolver, unchanged behavior.
- The tool-policy layer. Different concern (execution allowlist vs visibility).

Cluster 11 is the **visibility** consolidation. Execution-policy consolidation (if anything's needed) is a separate audit cluster.
