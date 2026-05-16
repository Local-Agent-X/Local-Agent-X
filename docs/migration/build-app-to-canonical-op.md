# build_app → canonical op migration plan

**Status:** Draft
**Target start:** TBD
**Depends on:** Worker-pool retirement (complete 2026-05-15, commits f14a44b → c14fde5)

---

## Goal

Move `build_app` from synchronous CLI-subprocess-blocking-the-chat-turn into a
**canonical-loop op** spawned via `op_submit_async`. Backed by a seeded
saved-agent template so per-provider dispatch is data, not tool code.

After this lands:
- Calling `build_app` returns an op ID immediately
- The build streams in the AGENTS sidebar like every other delegation
- Cancel works via the existing `opCancel` path
- Per-provider backend choice (codex CLI / claude CLI / direct write) lives
  in the agent template, not in builder-tools.ts
- One fewer shadow runtime outside canonical-loop

---

## Where we are after Phase 3 of worker-pool retirement

Phase 3 retired worker-pool's legacy fork lifecycle. Every **op** flows
through canonical-loop now. But several long-running execution paths still
run *outside* op tracking:

| Shadow runtime | Status | Plan |
|---|---|---|
| build_app CLI subprocess | Live shadow runtime — this doc | This doc |
| Autopilot (`op_ap_*`) | Live shadow runtime, separate loop | Future work |
| Voice sidecars (RVC, Chatterbox) | Live, Python subprocesses | Future work |
| self_edit CLI subprocess | Live, sandbox-gated | Future work |

**One op runtime ≠ one spine.** This migration closes one of the four gaps.

---

## What the user keeps

1. Chat agent can still trigger app builds.
2. `build_app` tool still exists by name — same call shape.
3. Per-provider behavior preserved (codex spawns codex CLI subprocess,
   anthropic spawns claude CLI subprocess, etc.).
4. Generated apps still land at `workspace/apps/<name>/`.
5. The `APP_READY: <url>` completion contract is preserved.

## What changes (user-visible)

1. `build_app` returns an op ID immediately instead of blocking.
2. Build progress shows in the AGENTS sidebar as `op_app_build_*` with
   live tool-progress chips (the existing canonical-loop streaming).
3. Cancel button on the sidebar card actually kills the build subprocess
   (today the tool's subprocess can outlive a chat-level cancel).
4. Failure surfaces as op error + chat notification, not as an inline
   tool error embedded in a 5-min-stale chat response.

---

## Architecture

### The saved-agent template

Seed on first run via `AgentTemplateStore.seedDefaults()` (already exists at
[src/agent-store.ts:316-323](../../src/agent-store.ts#L316-L323)). New template:

```json
{
  "id": "app-builder",
  "name": "App Builder",
  "role": "App Builder",
  "description": "Builds web apps in workspace/apps/. Strategy varies per provider.",
  "icon": "🛠",
  "systemPrompt": "<the existing builderPrompt from builder-tools.ts:114-129>",
  "allowedTools": ["write", "read", "edit", "bash", "list_directory"],
  "providerStrategy": {
    "codex": "cli-subprocess",
    "anthropic": "cli-subprocess",
    "default": "in-canonical-sub-agent"
  },
  "requiresWorktree": false
}
```

The system prompt is the existing `builderPrompt` template — same rules,
same WEBSITE_RULES_FRAGMENT, same APP_READY contract.

### Two execution strategies

LAX has six providers (codex, anthropic, qwen via Ollama, cerebras, grok,
gemini). The build_app canonical op picks an execution strategy per provider:

| Strategy | Used by | Mechanism |
|---|---|---|
| `cli-subprocess` | codex, anthropic | Op's adapter spawns external CLI (`codex --dangerously-bypass…` or `claude -p`). Works around the subscription endpoints' output-truncation cap. Streams progress via the existing `streamProgress()` parser. |
| `in-canonical-sub-agent` | qwen, cerebras, grok, gemini (and any future provider) | Op runs through canonical-loop's `agent-runner.ts` with `write` / `read` / `edit` / `bash` in `allowedTools`. No subprocess. The provider's HTTP adapter drives the tool loop natively. |

The `default` field is the fallback for any provider not explicitly named —
new providers get `in-canonical-sub-agent` automatically, which is the
correct behavior for HTTP-only providers without truncation issues.

**Why this is cleaner for the HTTP providers:**
Today these providers hit [builder-tools.ts:77-82](../../src/tools/builder-tools.ts#L77-L82)
which returns `isError: true` and tells the chat agent to use `write` tool
inline. That blocks the chat turn for the full build duration and fills the
chat's context with HTML. After this migration, those providers run the build
as an async sidebar op — same UX as codex/anthropic, no chat blocking.

**Why subprocess for codex/anthropic stays:**
The CLI subprocess has its own connection to the provider (not the
subscription endpoint), bypassing the per-tool-call output cap that
otherwise truncates 41KB+ HTML files. Without it, codex specifically
produces broken output for non-trivial apps.

### The new `build_app` tool

Thin wrapper. Takes `name` + `prompt` + optional `backend`. Builds an
`Op` with `type: "app_build"`, calls `canonicalLoopEntry`, returns op ID.

```ts
// New build_app implementation (sketch)
async execute(args) {
  const appName = normalize(args.name);
  const prompt = String(args.prompt || args.description || "");
  const backend = String(args.backend || "auto");

  // Render the prompt the way builder-tools.ts does today —
  // appDir, assets manifest, website rules detection, etc.
  // (Lift this logic verbatim from builder-tools.ts:87-129)
  const renderedPrompt = renderBuilderPrompt({ appName, prompt, backend });

  const op = await buildOpFromArgs({
    task: renderedPrompt,
    type: "app_build",
    success_criteria: [`APP_READY: <url> emitted`, "index.html written"],
    lane: "build",
    preferred_provider: backend === "auto" ? undefined : backend,
    max_iterations: 50,
    max_wall_time_ms: 10 * 60 * 1000,
  });

  // Adapter selection — same logic ops/tools.ts already has for
  // op_submit_async. Codex provider → CodexAdapter, otherwise lane
  // default AnthropicAdapter.
  registerProviderAdapter(op);
  canonicalLoopEntry(op, sessionId ? { sessionId } : {});

  return {
    content:
      `App build queued — op ${op.id} (lane=build).\n` +
      `Tracking in sidebar. The user will see a notification when ` +
      `APP_READY emits with the URL.\n` +
      `Cancel: op_kill(op_id="${op.id}")`,
    metadata: {
      chip: { kind: "op-submitted", label: `Building ${appName}`, opId: op.id },
    },
  };
}
```

### Why this is "one spine closer"

| Before | After |
|---|---|
| build_app spawns subprocess synchronously | build_app spawns canonical op |
| Subprocess not in op-store | Op in op-store, full event log |
| No sidebar visibility | Sidebar card with streaming chips |
| Cancel doesn't reliably kill subprocess | opCancel propagates through canonical adapter chain |
| Per-provider dispatch hardcoded in builder-tools.ts | Per-provider in agent template + adapter selection |
| Chat turn blocked for 1-5 min | Chat turn returns in ~100ms |

---

## Phases

### Phase 1 — Seed the app-builder agent template

Low-risk groundwork. No behavior change yet.

1. Add `app-builder` template to `AgentTemplateStore.seedDefaults()`.
2. Move `builderPrompt` construction logic from
   [src/tools/builder-tools.ts:114-129](../../src/tools/builder-tools.ts#L114-L129)
   into a shared helper `src/tools/render-builder-prompt.ts` so both the
   old tool and the new canonical op can use it during transition.
3. Move asset-manifest + website-rules detection to the same helper.
4. Verify the template seeds correctly on a fresh `~/.lax/`.
5. Tests: snapshot the rendered prompt for a known input matches old behavior.

Commit: `feat(agents): seed app-builder template, extract prompt renderer`

### Phase 2 — Build the canonical op path

Implement the new flow alongside the old one. Behind a feature flag.

1. Add op type `"app_build"` to op type registry.
2. Wire adapter selection in [src/ops/tools.ts](../../src/ops/tools.ts) so
   `type: "app_build"` ops pick the right adapter (codex CLI vs claude CLI
   vs direct write).
3. Add a thin `build_app_canonical` tool that uses the new path. Keep the
   existing `build_app` tool unchanged.
4. Feature flag `LAX_BUILD_APP_CANONICAL=1` routes `build_app` calls to
   the new tool internally; default off.
5. Smoke: spawn an app build via the canonical path on each provider,
   verify sidebar card, verify APP_READY, verify cancel.

Commit: `feat(ops): add canonical app_build op path behind flag`

### Phase 3 — Flip default + remove old path

After Phase 2 soaks for a day or two of real use.

1. Set `LAX_BUILD_APP_CANONICAL=1` as default (canonical-loop precedent —
   same flag-flip pattern as Phase 1 of worker-pool retirement).
2. Soak 24h.
3. Delete the old subprocess-spawning path:
   - `buildWithCodex` and `buildWithClaude` from
     [src/tools/builder-tools.ts:237-322+](../../src/tools/builder-tools.ts#L237)
   - `streamProgress` helper if no other caller
   - `build_app_canonical` collapses back to just `build_app`
4. Drop the feature flag.
5. Update [src/canonical-loop/middlewares/auto-build-app.ts](../../src/canonical-loop/middlewares/auto-build-app.ts)
   to synthesize the new tool-call shape. The middleware itself stays —
   it's still the right place to convert build-intent prose into a real
   tool call.

Commit: `refactor(ops): retire legacy build_app subprocess path`

---

## Removal targets (when migration completes)

### Code deletions
- `buildWithCodex()` in builder-tools.ts (~80 lines)
- `buildWithClaude()` in builder-tools.ts (~80 lines)
- `streamProgress()` helper if unused elsewhere — grep first
- The synchronous tool body in `buildAppTool.execute` — replaced with op
  spawn

### Logic moved (not deleted)
- `renderBuilderPrompt()` — kept as shared helper for the new path
- WEBSITE_RULES_FRAGMENT — kept, called from renderer
- `looksLikeWebsiteRequest()` + `listAssetsDir()` — kept

### Tests to update
- Any test that asserts `build_app` returns synchronously with the URL —
  update to assert it returns an op ID
- Any test that mocks the codex/claude subprocess spawn — update to mock
  the canonical-loop adapter instead

### UI surfaces to update
- [public/js/chat-tool-cards.js](../../public/js/chat-tool-cards.js) — the
  build_app card renderer probably expects the old synchronous shape;
  needs to handle the new op-submitted chip
- [public/js/apps-ide.js](../../public/js/apps-ide.js) — same likely needed

---

## What it does NOT close

This migration moves build_app into canonical. It does NOT:
- Move autopilot into canonical (separate lifecycle, `op_ap_*`)
- Move voice Python sidecars into canonical (out-of-process, language barrier)
- Move self_edit into canonical (sandbox gates are a different concern)

Each is its own future migration. After this lands, three shadow runtimes
remain. The strangler-fig continues.

---

## Risk inventory

| Risk | Mitigation |
|---|---|
| Sidebar UI doesn't render `app_build` op cards the way users expect | Phase 2 smoke explicitly tests the card render before flipping default |
| Codex CLI / claude CLI subprocess inside a canonical op has different timeout semantics than today | Use canonical-loop's existing `max_wall_time_ms` — set conservatively (10min), reuse the agent-runner timeout machinery |
| `APP_READY: <url>` post-completion message — chat agent today reads this from the synchronous tool result. As an async op, the URL needs to be surfaced via op completion event | Op completion event already carries final output; chat agent reads it via session-bridge auto-notification |
| Cancel of an `op_app_build` mid-write leaves a partial app dir | Same as today; canonical op's cancel signal flows through adapter abort → subprocess kill |
| Intent-classifier forced tool choice (today: `build_app`) still works | Yes — the tool name doesn't change. Intent classifier still forces `build_app`; the tool just dispatches differently underneath |

---

## Open questions

1. **Saved-agent vs hardcoded template** — should the template literally
   be persisted to `~/.lax/agent-templates.json` (seeded on first run), or
   shipped as code in `src/agents/built-in/app-builder.ts` that the
   AgentTemplateStore reads at boot? Code shipping is more reliable
   (survives `~/.lax` wipe, version-controlled, no migration on schema
   changes); persistence allows user override.
2. **Anthropic strategy choice** — Anthropic has both a CLI subprocess
   path (today's `buildWithClaude`) AND an HTTP API path with no truncation
   limit. The plan defaults Anthropic to `cli-subprocess` for behavioral
   parity with today, but the in-canonical-sub-agent path would work too
   and would surface progress more granularly. Worth A/B testing post-launch.
3. **Telemetry / cost** — today the build_app spawn is invisible to the
   token-tracker. As a canonical op, it'll show up in the user's usage
   metrics. That's correct behavior but may surprise users seeing higher
   counts. Worth a UI annotation.

---

## Done criteria

- [ ] `build_app` tool returns op ID, not synchronous result
- [ ] `op_app_build_*` cards visible in AGENTS sidebar with streaming progress
- [ ] Cancel via sidebar actually stops the underlying subprocess
- [ ] Codex provider builds work end-to-end via canonical op
- [ ] Anthropic provider builds work end-to-end via canonical op
- [ ] No regressions in app output quality vs the current path
- [ ] `buildWithCodex` / `buildWithClaude` deleted from builder-tools.ts
- [ ] `~/.lax/agent-templates.json` contains the `app-builder` template
  on a fresh install
- [ ] All existing builder-tools tests pass; new tests added for the
  canonical path
