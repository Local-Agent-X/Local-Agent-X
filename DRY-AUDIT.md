# DRY Audit — Local Agent X (whole repo)

**Scope**: `src/`, `packages/arikernel/*`, `integrations/`, root-level docs, `docs/`, `config/system-prompt.md`, install scripts.
**Excluded**: `node_modules`, `dist`, `build`, lockfiles, `*.db*`, `voice-models/`, `public/` (assets only spot-checked), `eval/`, `tests/` (test fixtures not audited as findings).
**Artifact classes**: code, prompts, configs, docs.
**Date**: 2026-05-13.
**Method**: 6 read-only Explore agents, one per slice (providers, loops, voice, tools, memory/security/sync, docs).

---

## Summary

15 findings as originally written. **F9 was reclassified to "intentional divergence" on 2026-05-13** after discovering that the `open-voice` library was a shelved alternative — see the tolerable shelf below. Effective active findings: **14**. **6 high**, **5 medium**, **3 low**, plus the tolerable/intentional/false-positive shelf at the bottom.

> **Correction (2026-05-13):** F9 ("Voice-session and gpu-session reinvent clause-chunker/preroll/playback") was a false positive. The Explore agent trusted the `integrations/open-voice/README.md` framing that open-voice was the canonical successor — that framing was stale. In reality the open-voice library was an alternative implementation that got shelved when the three-tier sidecar approach (tier4 ONNX Kokoro / gpu-session / realtime) proved adequate, and the library was never installed as a project dependency. What the audit called "duplication" is deliberate divergence from a parked alt-path. F9 is moved to the tolerable shelf; the related Phase 3B sections of the repair plan are dropped.

Top concerns (the ones that bite first):

- **Two agent runtimes coexist.** Chat goes through `canonical-loop` (persisted, recoverable). Everything else — `invokeAgent`, primal-auto-build sub-agents, cron missions — goes through `agency/handler.ts` (in-memory EventBus, no audit trail). Same job, two implementations, different terminal-state vocabularies.
- **Three parallel tool systems.** Three registries, two dispatch paths (chat-side `tool-executor.ts` vs `arikernel/tool-executors`), and policy split across `src/tool-policy`, `src/security`, `src/threat`, and `arikernel/policy-engine` with no cross-awareness. **The approval gate exists only on the chat-path** — arikernel-routed tool calls skip it. This is a security-relevant duplication.
- **Provider-ID type drift, already real.** `providers/types.ts` and `model-fallback.ts` are missing `"cerebras"` and `"ollama-cloud"` even though `resolve-provider.ts` accepts them. Adding cerebras yesterday required touching 5 files.
- **Three memory write paths, three different taint gates.** `memory_save` blocks at injection score ≥0.3; `end-of-turn-write` does no taint check (trusts the Haiku classifier); `auto-extract` calls `checkMemoryTaint` but only logs a warning. All three reach the same files. Durable prompt-injection surface.
- **Four AUDIT* docs document one audit.** "What's the current state" requires reading 3+ files. AUDIT-PLAN.md still reads as prospective while AUDIT-STATE.md says complete.

---

## Source-of-truth map

| Concept | Locations | Canonical? |
|---|---|---|
| Provider IDs | [`resolve-provider.ts:36`](src/agent-request/resolve-provider.ts#L36), [`settings/providers.ts:110`](src/routes/settings/providers.ts#L110), [`providers/types.ts:18`](src/providers/types.ts#L18), [`model-fallback.ts:28`](src/model-fallback.ts#L28) | **No — 4 copies, 2 stale** |
| Cerebras model defaults | `resolve-provider.ts`, `settings/providers.ts` (×2), `public/js/apps.js`, `public/app.html` | **No — 5 copies** |
| Reasoning-capable model regex | [`openai-http.ts:21`](src/providers/adapters/openai-http.ts#L21) | Yes |
| Provider baseURL routing (HTTP family only) | [`openai-compat.ts:548`](src/canonical-loop/adapters/openai-compat.ts#L548) (hardcoded if-branch per provider). Anthropic is **not** in this chain — it rides through the Claude CLI subprocess, intentionally. | Yes, but if-chain doesn't scale within the HTTP family |
| Tool registry | [`tools/registry-build.ts`](src/tools/registry-build.ts) (`allTools[]`), [`tool-search.ts`](src/tool-search.ts) (`ToolRegistry`), [`arikernel/tool-executors/registry.ts`](packages/arikernel/tool-executors/src/registry.ts) (`ExecutorRegistry`) | **No — 3 registries** |
| Tool dispatcher | [`tool-executor.ts`](src/tool-executor.ts) (chat), `arikernel/tool-executors/*` (non-chat) | **No — 2 dispatch paths, no cross-awareness** |
| Tool policy | `src/tool-policy/`, `src/security/`, `src/threat/`, `arikernel/policy-engine/` | **No — 4 layers, no merge** |
| Tool approval gate | [`approval-manager.ts`](src/approval-manager.ts), gated only in [`tool-executor.ts:571-586`](src/tool-executor.ts#L571-L586) | **Yes on chat-path, MISSING on arikernel-path** |
| Agent runtime | [`canonical-loop/`](src/canonical-loop/) (chat + `runAgentViaCanonical`), [`agency/handler.ts:304`](src/agency/handler.ts#L304) (`invokeAgent`, primal-auto-build) | **No — chat vs agents diverge** |
| Terminal-state vocabulary | canonical: `{succeeded, failed, cancelled}` in [`chat-runner.ts:59`](src/canonical-loop/chat-runner.ts#L59), [`agent-runner.ts:53`](src/canonical-loop/agent-runner.ts#L53), [`control-api.ts:184`](src/canonical-loop/control-api.ts#L184); handler-side: `{done, error, cancelled, timeout}` in [`agents/run.ts:47`](src/agents/run.ts#L47) | **No — different sets** |
| Memory write entry points | [`memory/tools/save.ts`](src/memory/tools/save.ts), [`memory/end-of-turn-write.ts`](src/memory/end-of-turn-write.ts), [`memory/auto-extract.ts`](src/memory/auto-extract.ts), [`memory/personality.ts`](src/memory/personality.ts) (direct `readFileSync`/`atomicWriteFileSync`) | **No — 3 write paths + 1 direct-file path** |
| Credential read | `secrets.ts` (vault), `auth.ts`/`auth-anthropic.ts` (files), `process.env` via config, `hooks/hook-engine.ts` (`scrubEnv` regex), `security/credentials.ts` (`redactCredentials` regex) | **No — 5 paths, scrubber lists diverge** |
| Voice session orchestration | [`voice-session.ts`](src/voice/voice-session.ts), [`gpu-session.ts`](src/voice/gpu-session.ts), [`realtime/realtime-session.ts`](src/voice/realtime/realtime-session.ts). The `integrations/open-voice/bridge.ts` file is dead code from a shelved migration; do not treat as a current path. | Yes — three-tier sidecar (tier4/gpu/realtime) is the canonical voice architecture |
| Clause-chunker / preroll / playback tracker | inline in `voice-session.ts:204-640` AND `gpu-session.ts:20-210` | Intentional — see F9 on the tolerable shelf (open-voice was a shelved alt, not a migration target) |
| STT dispatch | [`stt-providers/index.ts:36-79`](src/voice/stt-providers/index.ts#L36-L79) | Yes |
| TTS variant registry | [`tier4/tier4-factory.ts`](src/voice/tier4/tier4-factory.ts) | Yes |
| Kokoro/Edge voice lists | [`tier4/kokoro-voices.ts`](src/voice/tier4/kokoro-voices.ts), [`tier4/edge-voices.ts`](src/voice/tier4/edge-voices.ts) | Yes |
| "Current audit refactor state" | `AUDIT.md`, `AUDIT-PLAN.md`, `AUDIT-STATE.md`, `AUDIT-HANDOFF-P4.md` | AUDIT-STATE.md self-declares SOT, but under-linked |
| Defense architecture / trust model | `SECURITY.md`, `THREAT-MODEL.md` (parallel-drafted, same timestamp) | **No — overlap with unclear ownership** |
| Project setup / "start here" | `install.bat`, `install.ps1`, `install.sh`, `start.bat`, `AGENTS.md` | **No README** |

---

## Findings

### F1 — Two agent runtimes; chat persisted, agents not
- **Category**: Harmful
- **Risk**: High
- **Confidence**: High
- **Locations**:
  - Canonical (chat + `runAgentViaCanonical`): [`canonical-loop/turn-loop.ts:79`](src/canonical-loop/turn-loop.ts#L79), [`chat-runner.ts:240+`](src/canonical-loop/chat-runner.ts#L240), [`agent-runner.ts`](src/canonical-loop/agent-runner.ts)
  - Handler/Agency (`invokeAgent`, primal-auto-build sub-agents): [`agency/handler.ts:304`](src/agency/handler.ts#L304) (`runAgentAsync`), [`agents/invoke.ts`](src/agents/invoke.ts), [`primal-auto-build/orchestrator/`](src/primal-auto-build/orchestrator/)
- **What's duplicated**: "Run an assistant turn — assemble input, call model, dispatch tools, accumulate messages, decide when done."
- **Drift evidence**: Canonical writes `op_events.jsonl`, `op_messages.jsonl`, `op_turns.jsonl`; Handler emits EventBus only — no persistence, no audit trail, no replay, no lease/heartbeat recovery. Terminal-state vocabularies don't match (`succeeded/failed/cancelled` vs `done/error/cancelled/timeout`). Canonical = today's commit; Handler = yesterday's. Both are actively maintained.
- **Recommendation**: Rung 5 — shared protocol + multi-implementation, with Handler routed *through* canonical instead of beside it. Concretely: `runAgentViaCanonical` already exists; route `invokeAgent` and primal-auto-build chunk workers through it. Don't try to unify the two state machines in place — pick one (canonical) and retire the other.
- **Why not leave it**: An agent run that crashes inside primal-auto-build has no recovery path. Tests/debuggers can't replay a Handler agent. Two state-machine vocabularies leak into anything that compares run status.
- **Why this rung**: Rungs 1–4 don't fit — this is a runtime, not a value or function. Rung 6 (codegen) is overkill; the protocol already exists.

### F2 — Three parallel tool registries
- **Category**: Harmful
- **Risk**: High
- **Confidence**: High
- **Locations**:
  - [`src/tools/registry-build.ts`](src/tools/registry-build.ts) — `allTools[]` array + `buildToolRegistry()`
  - [`src/tool-search.ts`](src/tool-search.ts) — `ToolRegistry` class wraps `allTools` with eager/deferred tagging
  - [`packages/arikernel/tool-executors/src/registry.ts`](packages/arikernel/tool-executors/src/registry.ts) — `ExecutorRegistry` keyed by `ToolClass` enum
- **What's duplicated**: "The list of tools the system knows about." Three registries with different keying (name vs `ToolClass`), different metadata, no cross-reference.
- **Drift evidence**: `bootstrap-tools.ts` calls `buildToolRegistry()` *and* separately registers MCP tools afterward to avoid duplicates — a manual catch-up dedup step, which is the signature of an unowned registry. AriKernel registry has no MCP at all.
- **Recommendation**: Rung 4 — one shared registry module that both chat-path and arikernel consume. Define tools once, expose adapters for each runtime's keying needs.
- **Why not leave it**: Adding a tool requires deciding which 1–3 registries to touch. MCP tools are silently absent from the arikernel path.

### F3 — Two tool dispatchers, only one enforces approval (security-relevant)
- **Category**: Harmful
- **Risk**: High
- **Confidence**: High
- **Locations**:
  - Chat-path dispatcher: [`tool-executor.ts:executeSingleTool()` L197–703](src/tool-executor.ts#L197-L703), approval gate at [L571–586](src/tool-executor.ts#L571-L586)
  - AriKernel dispatcher: [`packages/arikernel/tool-executors/src/{file,shell,http,database}.ts`](packages/arikernel/tool-executors/src/) — no approval check
- **What's duplicated**: "Given a tool call, execute it." Two execution stacks coexist, no cross-call.
- **Drift evidence**: `approval-manager.ts` exists once; only the chat-path consults it. If a code path routes a tool call through arikernel (or if a future caller does), dangerous tools (`bash`, `write`) execute without consent.
- **Recommendation**: Rung 3 — extract the gate chain (`securityLayer → toolPolicy → threatEngine → approvalManager`) into a shared pre-dispatch function that *every* dispatcher must call. Or collapse to a single dispatcher (preferred, see F2).
- **Why not leave it**: This is the canonical "rule lives in one copy but should apply to both paths" case. Approval is a safety invariant; partial enforcement is worse than none because it gives a false sense of coverage.

### F4 — Four tool-policy/security layers with no cross-awareness
- **Category**: Harmful
- **Risk**: High
- **Confidence**: High
- **Locations**:
  - [`src/tool-policy/default-rules.ts`](src/tool-policy/default-rules.ts) — DEFAULT_POLICY config rules
  - [`src/security/layer-core.ts`](src/security/layer-core.ts) — file/shell/network policy layer
  - [`src/threat/tool-chain.ts`](src/threat/tool-chain.ts) — exfil/loop/encoding detector + trust ledger
  - [`packages/arikernel/policy-engine/src/engine.ts`](packages/arikernel/policy-engine/src/engine.ts) — capability/taint/constraint engine, plus separate `defaults.ts`
- **What's duplicated**: "What tool actions are allowed under what conditions." Four rule systems, each with its own model.
- **Drift evidence**: `tool-executor.ts` chains Layer -1 (`ariEvaluate`), Layer 0 (`checkSessionPolicy`), Layer 3 (`toolPolicy.evaluate`) sequentially — none aware of the others' decisions. `arikernel/policy-engine` has its own DEFAULT_RULES file separate from `src/tool-policy/default-rules.ts`.
- **Recommendation**: Rung 2 — one shared policy schema (Zod), one evaluator that returns a `{allowed, reasons[]}` decision. Each layer becomes a rule pack feeding the same evaluator. Then a single call site decides.
- **Why not leave it**: Already drifted (the two `defaults` files were drafted independently). A rule added in one place silently doesn't apply in the others.

### F5 — Three memory-write entry points, inconsistent taint gates
- **Category**: Harmful
- **Risk**: High
- **Confidence**: High
- **Locations**:
  - [`src/memory/tools/save.ts`](src/memory/tools/save.ts) — tool path; normalizes → `checkMemoryTaint` (blocks ≥0.3) → `sanitizeForMemory`
  - [`src/memory/end-of-turn-write.ts`](src/memory/end-of-turn-write.ts) — fires Haiku classifier in background → writes directly. **No taint check.**
  - [`src/memory/auto-extract.ts`](src/memory/auto-extract.ts) — calls `checkMemoryTaint` but only logs a warning; does not block
  - [`src/memory/personality.ts`](src/memory/personality.ts) — bypasses the index API entirely (raw `readFileSync` / `atomicWriteFileSync` on `IDENTITY.md`)
- **What's duplicated**: "How memory gets written safely." Each entry point reimplements its own gate composition.
- **Drift evidence**: Three different sanitization compositions. `MEMORY_INJECTION_PATTERNS` (12 patterns in `sanitize.ts:278-292`) is a strict subset of `INJECTION_PATTERNS` (40+ in `sanitize.ts:20-61`); memory path catches fewer attacks than external-content path.
- **Recommendation**: Rung 3 — a single `writeMemorySafely(content, source)` function that owns the full gate chain (normalize → taint check → sanitize → write). Every entry point calls it. EOT and auto-extract callers can override the *threshold* but not the *gate composition*.
- **Why not leave it**: Memory is persistent and feeds the system prompt. A prompt-injection that makes it past `auto-extract` (which only warns) is durable across sessions.

### F6 — Provider-ID type drift, already real
- **Category**: Harmful
- **Risk**: High (already drifted)
- **Confidence**: High
- **Locations**:
  - Authoritative-ish: [`resolve-provider.ts:36`](src/agent-request/resolve-provider.ts#L36) `VALID = ["codex","xai","openai","anthropic","local","ollama-cloud","gemini","cerebras","custom"]`
  - [`settings/providers.ts:104-113`](src/routes/settings/providers.ts#L104-L113) — DEFAULT_MODEL object, same set
  - **Stale**: [`providers/types.ts:18`](src/providers/types.ts#L18) — missing `"cerebras"`, `"ollama-cloud"`
  - **Stale**: [`model-fallback.ts:28`](src/model-fallback.ts#L28) — same omissions
- **What's duplicated**: The set of supported providers, encoded as a runtime list in one file and a TypeScript union in others.
- **Drift evidence**: The 2026-05-13 cerebras commit (`7f0ab77`) added it to runtime lists but not to the type unions. Any type-checked code referencing `AgentOptions.provider` cannot represent a Cerebras request.
- **Recommendation**: Rung 1 + 2 — single `PROVIDER_IDS` array constant, derive the TypeScript union via `typeof PROVIDER_IDS[number]`. One file, both worlds.
- **Why not leave it**: The cerebras commit *should* have failed type checks somewhere and didn't, which means the type unions aren't being used to constrain real call sites. Each future provider risks the same.

### F7 — "Current audit refactor state" scattered across 3+ docs
- **Category**: Harmful
- **Risk**: High
- **Confidence**: High
- **Locations**:
  - [`AUDIT.md`](AUDIT.md) — findings + criticals (2026-05-12)
  - [`AUDIT-PLAN.md`](AUDIT-PLAN.md) — phases 0–5, reads prospective
  - [`AUDIT-STATE.md`](AUDIT-STATE.md) — self-declares "single source of truth," says "AUDIT REFACTOR COMPLETE"
  - [`AUDIT-HANDOFF-P4.md`](AUDIT-HANDOFF-P4.md) — fresh-session briefings, pre-P4 state snapshot
- **What's duplicated**: The current refactor status. Plan reads as todo, State says done, Handoff is a stale snapshot. A reader landing on PLAN won't know it's complete.
- **Drift evidence**: Already drifted — STATE timestamps later than PLAN, but PLAN has no completion markers. HANDOFF-P4's "state on handoff" describes a moment in time that no longer exists.
- **Recommendation**: Rung 7 — keep AUDIT-STATE as the single live doc; archive the others under `docs/audits/2026-05-audit/` and link from STATE. Or merge: one `AUDIT.md` with sections for findings / plan / status / handoffs, each timestamped.
- **Why not leave it**: This is the documentation analog of the agent-runtime split — multiple files trying to describe the same in-progress thing, drifting in real time.

### F8 — Cerebras patch required 5 files (no provider registry)
- **Category**: Harmful
- **Risk**: Medium
- **Confidence**: High
- **Locations**:
  - [`resolve-provider.ts:116`](src/agent-request/resolve-provider.ts#L116) — default model
  - [`settings/providers.ts:30`](src/routes/settings/providers.ts#L30) — provider list + model array
  - [`settings/providers.ts:110`](src/routes/settings/providers.ts#L110) — DEFAULT_MODEL dict
  - `public/js/apps.js`, `public/app.html` (per commit `7f0ab77`) — UI dropdown
  - Plus the F6 type-union files
- **What's duplicated**: Per-provider knowledge (id, models, defaults, UI label) is shattered across backend + UI.
- **Drift evidence**: Commit `7f0ab77` was a fix because the model list was wrong in 3+ places. Each provider addition is an N-file dance.
- **Recommendation**: Rung 4 — one `providers/registry.ts` module that exports `{id, label, models, defaultModel, baseURL, env, capabilities}` per provider; UI and resolver both read from it. Also subsumes F10 (baseURL hardcoding).
- **Why not leave it**: Adding the next provider will be the same 5-file dance with the same drift risk.

### F9 — Voice-session and gpu-session reinvent clause-chunker/preroll/playback
- **Category**: ~~Harmful~~ → **Intentional** (reclassified 2026-05-13)
- **See**: tolerable/intentional shelf below for the corrected entry.
- **Note**: Original finding assumed open-voice was the canonical migration target. It was a shelved alternative — three-tier sidecar (tier4 / gpu-session / realtime) is canonical. The two "duplicated" implementations are deliberate divergence from a parked alt-path, not knowledge that must stay in sync.

### F10 — Provider baseURL routing as hardcoded if-branch
- **Category**: Harmful
- **Risk**: Medium
- **Confidence**: High
- **Locations**: [`openai-compat.ts:548`](src/canonical-loop/adapters/openai-compat.ts#L548) — `if (provider === "cerebras") return { baseURL: "https://api.cerebras.ai/v1", ... }`
- **What's duplicated**: Per-provider routing knowledge encoded as a switch in one file, with the provider name encoded as a string in F6's four-place enum and F8's UI lists.
- **Drift evidence**: Each new provider adds another `if` here. Cerebras baseURL is here AND not derivable from the type union (because the type union doesn't include cerebras — F6).
- **Recommendation**: Rung 1 — `baseURL` becomes a field on the per-provider registry entry from F8's recommendation. Resolves with F8.
- **Why not leave it**: Pairs tightly with F8; same fix covers both.

### F11 — Five credential-read paths, scrubber lists diverge
- **Category**: Harmful
- **Risk**: Medium
- **Confidence**: High
- **Locations**:
  - Vault: [`src/secrets.ts`](src/secrets.ts) (`SecretsStore`)
  - Auth files: [`src/auth.ts`](src/auth.ts), [`src/auth-anthropic.ts`](src/auth-anthropic.ts)
  - Env: `process.env.*` via config at boot
  - OAuth state files (`tokens.json`, `anthropic-auth.json`)
  - Scrubbers (different rules): [`src/hooks/hook-engine.ts`](src/hooks/hook-engine.ts) (`scrubEnv` SCRUB_KEYS), [`src/security/credentials.ts`](src/security/credentials.ts) (`redactCredentials` regex)
- **What's duplicated**: "What counts as a credential" (for both reading and scrubbing). `resolve-provider.ts::hasCredsFor` checks 4 sources independently.
- **Drift evidence**: Hook scrubber uses `/^(ANTHROPIC_|OPENAI_|XAI_|...)/`; security redactor uses `/\b(sk-ant-|sk-|ghp_|xai-)/`. Different patterns, different coverage. A new pattern in one isn't reflected in the other.
- **Recommendation**: Rung 1 — single `CREDENTIAL_PATTERNS` constant + helper used by both scrubbers. Separate concern: a single `getCredential(name)` facade over the 5 read sources, so callers don't open-code which to check.
- **Why not leave it**: Adding a new API key shape requires updating two regex lists. One is going to get missed.

### F12 — SECURITY.md and THREAT-MODEL.md overlap on defense architecture
- **Category**: Harmful
- **Risk**: Medium
- **Confidence**: High
- **Locations**: [`SECURITY.md`](SECURITY.md), [`THREAT-MODEL.md`](THREAT-MODEL.md) — same timestamp (2026-05-04 09:38), both describe trust model + defense layers
- **What's duplicated**: The defense-layer architecture (Layer 1–5 in SECURITY ≈ Layer -1 to 3 in THREAT-MODEL) and the trust model (single-user, loopback, no multi-tenant). Different vocabularies, same content.
- **Drift evidence**: Layer numbering differs already. SECURITY.md also has placeholder `[TBD - add security contact email]` — release-blocker but not a DRY issue per se.
- **Recommendation**: Rung 7 — explicit split-and-link. SECURITY.md = user-facing policy (reporting, SLAs) referencing the threat model. THREAT-MODEL.md = design doc (actors, surfaces, layers). One `defense-layers.md` section that both link to, not duplicate.
- **Why not leave it**: A new attack surface needs to land in both docs or they diverge. Already happened with layer numbering.

### F13 — Terminal-state vocabulary drift between canonical and Handler
- **Category**: Harmful
- **Risk**: Medium
- **Confidence**: High
- **Locations**:
  - canonical (×3 redefinitions, all identical set): [`chat-runner.ts:59`](src/canonical-loop/chat-runner.ts#L59), [`agent-runner.ts:53`](src/canonical-loop/agent-runner.ts#L53), [`control-api.ts:184`](src/canonical-loop/control-api.ts#L184) — `{succeeded, failed, cancelled}`
  - handler: [`agents/run.ts:47`](src/agents/run.ts#L47) — `{done, error, cancelled, timeout}`
- **What's duplicated**: "What does it mean for an agent run to be over."
- **Drift evidence**: Different words for the same states; `timeout` exists on one side and not the other. Even within canonical, the set is redeclared in 3 files.
- **Recommendation**: Rung 1 — single `TERMINAL_STATES` constant + matching TypeScript type, imported everywhere. Resolves once F1 collapses the two runtimes; in the meantime, the constant prevents intra-canonical drift.
- **Why not leave it**: Anything comparing run status across the two systems must defensively translate. This is the wrong place to spend mental budget.

### F14 — Retry/backoff logic scattered across 5 layers
- **Category**: Tolerable (note: not a fix, but call it out)
- **Risk**: Low (no current bug, but discoverability cost)
- **Confidence**: High
- **Locations**: [`src/auto-retry.ts`](src/auto-retry.ts) (`withRetry`), [`tool-executor.ts:29-54`](src/tool-executor.ts#L29-L54) (`RETRYABLE_TOOLS`, `isTransientError`), [`workers/heartbeat.ts`](src/workers/heartbeat.ts), [`canonical-loop/worker.ts`](src/canonical-loop/worker.ts), [`circuit-breaker.ts`](src/circuit-breaker.ts)
- **What's duplicated**: Retry intent. But each layer's *contract* is genuinely different (per-call wrapper vs per-tool policy vs lease heartbeat vs circuit-breaker state machine).
- **Drift evidence**: No active drift; no shared rule to drift.
- **Recommendation**: Leave alone. These look duplicated but encode different decisions at different layers — coincidental similarity. Document with a one-line comment in each layer naming what it owns.
- **Why leaving it**: Collapsing them would create a god retry function with flag soup. Rule of three doesn't fire — each layer is genuinely once.

### F15 — No README; setup spread across install scripts + AGENTS.md
- **Category**: Harmful (documentation)
- **Risk**: Medium
- **Confidence**: High
- **Locations**: `install.bat`, `install.ps1`, `install.sh`, `start.bat`, `desktop-launch.bat`, `AGENTS.md` (invariants, not setup)
- **What's duplicated**: Install knowledge, spread across three scripts in three shells. No canonical "start here."
- **Drift evidence**: All three install scripts share a single 2026-05-04 11:18 timestamp — drafted together, but with no test that they agree on dependency versions, env vars, or steps.
- **Recommendation**: Rung 7 + 4 — one `README.md` linking to the scripts, plus one shared `scripts/install-common.mjs` that the three OS wrappers each invoke. Single source for the actual install logic.
- **Why not leave it**: No README is a release blocker. Three install scripts with no shared core *will* drift the next time one of them gets a fix the others miss.

---

## Tolerable / intentional / false positive (audit transparency)

Considered, deliberately left.

- **Anthropic CLI subprocess vs OpenAI-compatible HTTP adapters.** Different transports by design — direct HTTP fails for Sonnet/Opus on the Max plan, so Anthropic OAuth has to ride through the Claude CLI. Don't treat this as drift or flatten it into the HTTP if-chain. The repair plan's provider registry discriminates on `transport: "http" | "cli"` to make the divergence first-class.
- **`src/providers/adapter/` (singular) vs `src/providers/adapters/` (plural)** — Not duplication. `adapter/` holds the abstract interface + types; `adapters/` holds implementations. Naming hazard only — a future contributor might create `adapter/foo.ts` by mistake. Rename to `provider-types/` or merge into `adapters/index.ts` if you want to remove the foot-gun.
- **F9 — `voice-session.ts` / `gpu-session.ts` clause-chunker/preroll/playback** (reclassified 2026-05-13). Not duplication. The `open-voice` library at `C:\Users\manri\open-voice` was an alternative voice toolkit that got shelved when the three-tier sidecar approach (tier4 ONNX Kokoro / gpu-session / realtime) proved adequate. The library was never installed as a project dependency; `package.json` does not list it and `node_modules` does not contain it. What looked like "two inline reinventions of a shipped module" is canonical inline code plus a parked alt-implementation. Leave it.
- **`integrations/open-voice/` bridge file** — Dead code from when the open-voice migration was still planned. The bridge file (`bridge.ts`, ~130 LOC) imports from a `"open-voice"` npm package that isn't installed and is outside `tsconfig.rootDir` (never type-checked). Safe to delete in a future cleanup pass; flagged here so future audits don't re-treat it as a current path.
- **`src/agent-loop/`** — Just `inject-queue.ts` (40 LOC). Misleadingly named — sounds like a turn driver, only manages a FIFO. Not duplicating canonical-loop. Rename to `src/inject-queue/` if you want.
- **`src/orchestrator/` (`MemoryOrchestrator`)** — Memory pre-processing, not a turn driver. Orthogonal to canonical-loop. Name collision with primal-auto-build's orchestrator only — different jobs.
- **`src/primal-auto-build/orchestrator/`** — Build-loop supervisor, different lifecycle from canonical-loop. Specialized — not a shadow general loop. Its sub-agent invocation does ride F1's Handler path, which is where the issue actually lives.
- **STT dispatch** ([`stt-providers/index.ts`](src/voice/stt-providers/index.ts)), **TTS variant registry** ([`tier4/tier4-factory.ts`](src/voice/tier4/tier4-factory.ts)), **Kokoro/Edge voice lists** — single canonical home each, properly re-exported. Clean.
- **Whisper local-WASM variants vs OpenAI `whisper-1`** — Same word, different things. Local sherpa variants and an API model id; coincidental similarity.
- **`_noToolSupport` cache key** — Was a real bug (poisoned all endpoints for a model name), fixed to `${baseURL}::${model}`. Live in three callers but consistent; the rule has one definition.
- **`BUGS-FOUND.md`, `IMPLEMENTATION-REPORT.md`, `THINGS-TO-CLEAN-BEFORE-RELEASE.md`** — Three orthogonal lists, verified no overlap. Each is its own concern.
- **`AGENTS.md` vs `AUDIT.md`** — Style guide / invariants vs diagnostic findings. Different jobs, no overlap.
- **`docs/canonical-agent-design.md`, `docs/canonical-loop-prd.md`, `docs/supervisor-architecture-*`** — Design/spec docs predating or specifying the canonical-loop work. Not duplicating the AUDIT docs.
- **`src/embedding-providers/` wiring** — Provider passed by parameter everywhere; no global state to drift. Mild verbosity, not duplication.
- **User facts in memory vs system prompt** — System prompt is intentionally generic; memory stores user facts via auto-extract. Working as designed (no `Alex`/`Acme`/`ScanProgress` hardcoded in `config/system-prompt.md`).

---

## Prioritized actions

**Fix now** (high risk; some already drifting):

- **F3** — Lift the approval gate (and the rest of the chain) into a shared pre-dispatch function. Security-relevant.
- **F6** — Add `cerebras` and `ollama-cloud` to `providers/types.ts` and `model-fallback.ts` (or refactor to derive the type from the runtime list). Single-commit fix; type drift is already real.
- **F5** — Funnel all memory writes through one `writeMemorySafely()`. The `end-of-turn-write` path bypassing taint checking is the worst offender.
- **F7** — Reconcile the 4 AUDIT* docs. Pick AUDIT-STATE.md as the live doc, archive the others, or merge.
- **F15** — Write a README. Even a stub. The repo has no entry point and SECURITY.md still has `[TBD]` for the contact email — that's a release blocker.

**Fix soon** (medium; drift-likely or eats dev velocity):

- **F1** — Route `invokeAgent` and primal-auto-build through `runAgentViaCanonical`. Retire `agency/handler.ts` once nothing references it.
- **F2 + F4** — Consolidate to one tool registry and one policy evaluator. These pair naturally with F3.
- **F8 + F10** — Introduce `src/providers/registry.ts` with full per-provider metadata; remove the baseURL `if`-chain and the 5-file dance.
- **F11** — Single `CREDENTIAL_PATTERNS` constant; both scrubbers consume it.
- **F12** — Split SECURITY.md and THREAT-MODEL.md cleanly; cross-link instead of co-stating defense layers.
- **F13** — One `TERMINAL_STATES` constant + type, imported everywhere.

**Leave alone** (documented above):

- **F9** — Voice clause-chunker/preroll/playback duplication is intentional divergence from a shelved alt-library. Re-classified 2026-05-13.
- **F14** — Retry layers are coincidentally similar, not duplicated knowledge. Don't collapse.
- The provider `adapter/`-vs-`adapters/` directory pair, `src/agent-loop/` naming, the `integrations/open-voice/` bridge (dead code from shelved migration), embedding-provider wiring, the orthogonal root-level docs.

---

## Notes that fell out of scope but are worth flagging

- `SECURITY.md` has a literal `[TBD - add security contact email]` placeholder. Not a DRY issue; release blocker.
- `audit.db`, `*-tokens.db`, `*.log` files are tracked in the repo per `THINGS-TO-CLEAN-BEFORE-RELEASE.md`. Not a DRY issue.
- `src/cron/run-history.ts` is defined but `tools.ts` reads reports from the filesystem directly via `readdirSync` instead of using it — orphaned module, low priority.
