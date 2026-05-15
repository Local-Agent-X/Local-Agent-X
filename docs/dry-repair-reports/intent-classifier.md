# Intent classifier + tool_choice forcing

Branch: `fix/intent-classifier` (worktree: `C:/Users/manri/lax-intent`)

Closes the prose-narration regression where Primal described tool calls in brackets (`[Reading routes/]`, `[Calling http_request...]`) instead of emitting structured tool_use blocks. The structural fix is a selected-provider LLM intent classifier that fires after tool filtering in `prepare-request.ts` and pins `tool_choice` on the LLM adapter for three high-leverage primitives: `build_app`, `agent_spawn`, `self_edit`. Everything else (ordinary chat, ambiguous requests) stays `free` — the agent picks its own tool.

## Files changed

New
- [src/classifiers/intent-classifier.ts](../../src/classifiers/intent-classifier.ts) — 140 LOC. `classifyIntent(message)` + `NO_SPAWN_OVERRIDE_RE` + `hasLiteralToolCall(message)` skip-condition helpers.
- [test/intent-classifier.test.ts](../../test/intent-classifier.test.ts) — 140 LOC, 13 tests, all green. Mocks `classifyJson` for deterministic verdicts.

Modified
- `src/agent-request/types.ts:54-65` — added `ForcedToolChoice` type + `toolChoice` field on `PreparedAgentRequest`.
- `src/agent-request/prepare-request.ts:8` — imported `classifyIntent`, `hasLiteralToolCall`, `NO_SPAWN_OVERRIDE_RE`.
- `src/agent-request/prepare-request.ts:394-422` — wiring block: after the tools list is finalized, run `classifyIntent(message)` (skipping bridges, explicit overrides, literal-call pastes), verify the forced tool is in the per-turn tool list, attach `toolChoice` to the prepared request.
- `src/canonical-loop/chat-runner.ts:327-378` — thread `prepared.toolChoice` into each adapter factory via a new `forcedToolChoice` option.
- `src/canonical-loop/adapters/anthropic.ts:147-160, 213-225` — `AnthropicAdapterOptions.forcedToolChoice`; first-turn-only application via `input.turnIdx === 0`; carried on `AnthropicTransportRequest.forcedToolChoice`.
- `src/canonical-loop/adapters/anthropic-transport.ts:49-78` — translates `forcedToolChoice` into the direct-HTTP `tool_choice: {type:"tool", name}` body shape (via `forcedToolName` on `StreamOptions`). On the CLI/OAuth path the subprocess takes no flag for tool_choice, so the transport prepends a `[INTENT-FORCED TOOL]` directive to the system prompt instructing the model to call the named tool first.
- `src/anthropic-client/types.ts:35-42` — `StreamOptions.forcedToolName?: string`.
- `src/anthropic-client/stream-api.ts:6, 33-40` — when tools are shipped and the model lists the forced tool, emit Anthropic's `tool_choice: { type: "tool", name }` body field (otherwise fall through to the existing `"required"` → `{type:"any"}` mapping).
- `src/canonical-loop/adapters/openai-compat.ts:55-62, 80-101` — `OpenAICompatAdapterOptions.forcedToolChoice`; first-turn-only; forwarded onto `ProviderRequest.toolChoice` when the named tool is in the per-turn list.
- `src/providers/adapter/types.ts:29-32` — `ProviderRequest.toolChoice` widened to `"auto" | "required" | { type: "tool"; name: string }`.
- `src/providers/adapters/openai-http.ts:29-42, 55` — translates the canonical `{type:"tool", name}` shape into OpenAI Chat Completions' `tool_choice: {type:"function", function:{name}}` and passes it to `client.chat.completions.create`.
- `src/canonical-loop/adapters/codex.ts:23-35, 73-89` — `CodexAdapterOptions.forcedToolChoice`; first-turn-only; threaded onto `AnthropicTransportRequest.forcedToolChoice`.
- `src/canonical-loop/adapters/codex-transport.ts:55-79` — forwards the canonical `{type:"tool", name}` onto the codex-cli adapter's `ProviderRequest.toolChoice` after verifying the name is in the per-turn tools list.
- `src/codex-client.ts:93, 134-148` — `streamCodexResponse`'s `toolChoice` widened to also accept `{type:"tool", name}`; converted internally to the Responses-API-compatible `{type:"function", function:{name}}` body shape.

## Classifier system prompt

```
You decide which tool the assistant should be FORCED to call for this user turn. Reply with a JSON object: {"kind": "<one of: build_app | agent_spawn | self_edit | free>", "reason": "<short reason>"}

KINDS:

- build_app — user is asking to CREATE A NEW STANDALONE app, dashboard, page, tool, tracker, calculator, form, site, or similar artifact. The request is for a fresh thing that doesn't exist yet. Examples:
    "create a dashboard that imports our fastmail"
    "build me a kanban app"
    "make a calculator that converts USD to crypto"
    "scaffold a TODO list page"
    "generate a landing page for X"

- agent_spawn — user is asking to DELEGATE a long-running task to a named role/specialist: research, multi-step writing, code review, market scans, browsing-and-summarizing, anything that benefits from a focused worker run. Examples:
    "research current AI voice toolkits and write a summary"
    "have a coder review the kraken bot for bugs"
    "spawn a researcher to find the top 5 GLP-1 supplements"
    "delegate this competitor analysis to a market-research worker"

- self_edit — user is REPORTING A BUG OR BROKEN BEHAVIOR in THIS app (Local Agent X / LAX itself). The fix requires touching LAX source code under src/. Examples:
    "the dark-mode toggle doesn't flip when I click it"
    "settings page won't save my provider choice"
    "the voice mic icon is stuck on after I close voice"
    "chat history is getting truncated every turn"
    "edit src/voice/voice-session.ts to wire X"

- free — anything else. Ordinary conversation, status checks, casual questions, ambiguous requests, "how would you build..." (asking for discussion, not the build), "explain", "what is...", short acks, follow-ups, requests that don't unambiguously map to ONE of the three primitives above. When in doubt, choose "free" — forcing the wrong tool is worse than no forcing.

DISTINCTIONS:
- "create a dashboard for fastmail" → build_app (concrete artifact)
- "explain how you'd build a dashboard for fastmail" → free (discussion)
- "research X for me" → agent_spawn (delegation)
- "tell me about X" → free (just answer it)
- "the toggle doesn't work" → self_edit (LAX bug)
- "fix my todo app's toggle" → free (workspace edit, not LAX source — agent uses edit/write)

Reply with JSON only. No prose, no markdown fences.
```

User prompt template:

```
User message:
"<message up to 1200 chars>"

Return JSON only: {"kind": "build_app" | "agent_spawn" | "self_edit" | "free", "reason": "..."}
```

## toolChoice flow

```
prepare-request.ts:394    classifyIntent(message)
                          ↓ ForcedToolChoice | undefined
prepare-request.ts:421    PreparedAgentRequest.toolChoice
                          ↓
chat-runner.ts:327        const forcedToolChoice = ctx.prepared.toolChoice
                          ↓ split by provider
  Anthropic →             chat-runner.ts:330  createAnthropicAdapter({ forcedToolChoice })
                          anthropic.ts:160     opts.forcedToolChoice (set on adapter)
                          anthropic.ts:217     forcedToolChoice = input.turnIdx === 0 ? opts.forcedToolChoice : undefined
                          anthropic.ts:225     AnthropicTransportRequest.forcedToolChoice
                          anthropic-transport.ts:57   build cliAugmentedSystem with [INTENT-FORCED TOOL] directive
                          anthropic-transport.ts:69   streamAnthropicResponse({ ..., forcedToolName })
                          stream-api.ts:35    body.tool_choice = { type: "tool", name } (direct HTTP path)
  Codex →                 chat-runner.ts:340  createCodexAdapter({ forcedToolChoice })
                          codex.ts:35          opts.forcedToolChoice
                          codex.ts:76          AnthropicTransportRequest.forcedToolChoice (turn 0 only)
                          codex-transport.ts:63 ProviderRequest.toolChoice = { type: "tool", name }
                          codex-cli.ts:40      forwarded to streamCodexResponse
                          codex-client.ts:140  converted to { type: "function", function: { name } }
                          codex-client.ts:144  body.tool_choice
  OpenAI-compat →         chat-runner.ts:372  createOpenAICompatAdapter({ forcedToolChoice })
                          openai-compat.ts:62  opts.forcedToolChoice
                          openai-compat.ts:84  set on ProviderRequest.toolChoice (turn 0 only, name-in-list verified)
                          openai-http.ts:31    translate to { type: "function", function: { name } }
                          openai-http.ts:43    tool_choice in chat.completions.create body
```

## Skip conditions (caller-side, in prepare-request)

1. **Bridge channel** (`channel === "telegram" | "whatsapp"`) — bridge tools already constrained; forcing a chat-only tool would mismatch.
2. **`NO_SPAWN_OVERRIDE_RE.test(message)`** — user said "don't delegate / handle this yourself"; explicit intent wins.
3. **`hasLiteralToolCall(message)`** — user pasted `tool_name({...})`; explicit intent wins.

When the classifier returns a forced tool but it isn't in this turn's filtered tool list, a warning is logged and the forcing is dropped (we don't ship a `tool_choice` referencing a tool the model can't see — that would 400 the request).

## Acceptance check

- `npx tsc --noEmit -p tsconfig.json` → clean.
- `vitest run test/intent-classifier.test.ts` → 13/13 pass.
- `vitest run test/canonical-chat-runner-seed.test.ts test/canonical-loop-middlewares.test.ts test/canonical-loop-03-happy-path.test.ts test/canonical-loop-09-anthropic-conformance.test.ts` → 60/60 pass.
- `vitest run test/tool-filter-parity.test.ts test/tool-filter-supervisor-surface.test.ts test/memory-curate-classifier.test.ts test/response-classifier.test.ts test/response-classifier-refusal-wiring.test.ts` → 62/62 pass.
- Manual trace through `prepare-request.ts`: a "create a dashboard for fastmail" message bypasses every skip condition; the classifier fires; on a `build_app` verdict (and assuming `build_app` is in the per-turn tools list — it's in `CORE_TOOL_NAMES` so always is), `prepared.toolChoice = { type: "tool", name: "build_app" }` is set.
- For an ordinary chat message ("what's the weather"), the classifier returns `free`, `toolChoice` stays undefined, the adapters fall through unchanged.
- `grep "forcedToolChoice\|tool_choice" src/providers/adapters/openai-http.ts src/canonical-loop/adapters/openai-compat.ts src/canonical-loop/adapters/anthropic.ts src/canonical-loop/adapters/anthropic-transport.ts src/canonical-loop/adapters/codex.ts src/canonical-loop/adapters/codex-transport.ts src/anthropic-client/stream-api.ts src/codex-client.ts` confirms the plumbing reaches the SDK call site in every adapter.

## Adjacent issues noticed (NOT fixed in this commit)

- **prepare-request.ts L113 vs L150-170**: the build-intent strip-down (`filterToolsForMessage` → `BUILD_INTENT_TOOLS`) narrows the per-turn tool list when the message matches the build regex; then the tool-RAG path (L146-176) unions back to a wider semantic set. For a "create a dashboard" message both filters fire — the strip-down narrows to ~15 tools, the RAG union widens it back. They aren't drift, exactly, but the two paths are doing opposing work on the same message and the final tool count is non-obvious. Out of scope for this fix; flagged for a follow-up cleanup.
- The legacy `src/canonical-loop/middlewares/force-tool-use.ts` still writes its intent to `op.canonical.toolChoice` as a side channel that nothing reads. This commit doesn't change it, but with proper `forcedToolChoice` plumbing on every adapter, the legacy middleware becomes redundant for Codex's build/action intents — a future commit can either delete the legacy middleware or migrate its build-intent regex into the new path. Left as-is to keep this diff scoped.
- `src/anthropic-client/stream-cli.ts` (CLI subprocess) doesn't honor `forcedToolName` directly — the CLI's `--tool-choice` analog doesn't exist, so we get the same effect by prepending the `[INTENT-FORCED TOOL]` directive to the system prompt at the transport boundary. Works in practice, but it's a soft enforcement vs. the hard enforcement on the HTTP/SDK paths.

## Soak plan

After merge:

1. **Trigger the regression message**: in chat, send "create a dashboard that imports our fastmail". Expected: `build_app` tool call fires immediately on turn 0 (canonical events show `toolCount >= 1`, the `build_app` card appears in the UI). Both providers (Anthropic CLI + Codex). Without this fix: prose with `[Reading...]` brackets and `toolCount=0`.
2. **Trigger agent_spawn**: send "research current AI voice toolkits and write a 200-word summary". Expected: `agent_spawn` fires; AGENTS sidebar shows the spawned worker.
3. **Trigger self_edit**: send "the dark mode toggle doesn't flip when I click it". Expected: `self_edit` fires.
4. **Confirm free chat untouched**: send "what's the weather in McKinney" and "hi how are you" — chat path runs normally, no forced tool, ordinary text reply.
5. **Confirm overrides win**:
   - "create a dashboard but handle it yourself" → no forcing (NO_SPAWN_OVERRIDE_RE matches).
   - paste a literal `tool_search({"q":"x"})` block → no forcing.
6. **Confirm bridge path**: send a Telegram message that would otherwise trigger build_app — bridge skip-condition fires, no forcing.
7. **Classifier latency**: tail server log for `[classifier.intent]`. Verdicts should land in well under 1.5s on the user's active provider. If they consistently time out (`wallclock timeout at 1500ms`), bump the timeout or set `LAX_INTENT_CLASSIFIER=0` and investigate the provider.
8. **Drift check**: tail for `[intent] classifier picked X but it's not in this turn's tool list — skipping force`. If this fires on the test messages, the tool-RAG / build-intent narrowing dropped a core primitive — check `CORE_TOOL_NAMES` and the per-tier shrink.
9. **Spec-divergence check**: after a soak day, run the prose-detector telemetry (Layer 4 from commit 3a08823) and confirm the prose-degeneracy fall-through fires near-zero times for build/spawn/self_edit messages — the structural force should preempt it.
