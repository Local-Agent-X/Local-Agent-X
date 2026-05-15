# DRY Repair Plan — Local Agent X

**Companion to**: [DRY-AUDIT.md](DRY-AUDIT.md)
**Date**: 2026-05-13

This plan converts the 15 audit findings into ordered work. Each phase ends with a class of symptom that no longer occurs.

---

## Goal

Local Agent X has **one execution spine**:

- One agent runtime that every caller rides (chat, `invokeAgent`, primal-auto-build, cron).
- One tool registry + one dispatcher, with the security gate chain (taint → policy → threat → approval) lifted to a pre-dispatch function every dispatcher must call.
- One memory-write gate every entry point passes through.
- One provider registry that owns id, models, baseURL, defaults, capabilities; UI and resolver both read from it.
- One canonical "current state" doc per topic.

Adding a feature is a one-place change. Safety invariants apply regardless of routing.

---

## Symptom classes (acceptance vocabulary)

Each phase below names which class(es) collapse on completion:

- **A. Silent safety bypasses.**
- **B. N-file dance** for adding things.
- **C. Type drift** between runtime and type-system.
- **D. Behavior divergence** between supposedly-identical paths.
- **E. "Where does X live"** cognitive cost.
- **F. Stale shadow code.**

---

## Operating rules

- Each phase is one or more commits. Commits within a phase land in order.
- No batched mega-PRs. One commit, one finding family.
- Each commit names the audit finding(s) it closes in the message: `closes F6`, etc.
- Each commit must compile + pass type check. If a type narrowing reveals a real bug, that bug gets its own commit, then this work resumes.
- Reversibility: every Phase 1 + 2 commit is a pure refactor — same behavior, fewer code paths. Phase 3 + 4 include semantic moves (default flips, doc archival); each is feature-flagged or reversible by `git revert`.
- After each commit: recap what changed.

---

## Phase 1 — Safety closures

**Why first**: highest-risk findings + drift already real today + smallest diffs. These are the "stop the bleeding" commits.

### 1A. Derive `ProviderId` from the runtime list — closes **F6**
- **Touch**: 1 new constant, 4 type updates.
- **Files**:
  - New: `src/providers/provider-ids.ts` — `export const PROVIDER_IDS = ["codex","xai","openai","anthropic","local","ollama-cloud","gemini","cerebras","custom"] as const; export type ProviderId = typeof PROVIDER_IDS[number];`
  - Update: [`src/agent-request/resolve-provider.ts:36`](src/agent-request/resolve-provider.ts#L36) — import `PROVIDER_IDS`, drop local `VALID`.
  - Update: [`src/providers/types.ts:18`](src/providers/types.ts#L18) — replace union literal with `ProviderId`.
  - Update: [`src/model-fallback.ts:28`](src/model-fallback.ts#L28) — replace local `ProviderId` with the shared one.
  - Update: [`src/routes/settings/providers.ts`](src/routes/settings/providers.ts) — use `PROVIDER_IDS` where the array literal is built.
- **Done when**: typecheck passes; deleting `"cerebras"` from `PROVIDER_IDS` fails the build in `resolve-provider.ts` *and* `settings/providers.ts` *and* `model-fallback.ts`. (Adversarial check — verify the type is really load-bearing.)
- **Symptoms collapsed**: **C** (type drift), **B** (one place to add the next provider's id — full registry comes in 3A).
- **Reversibility**: trivial revert.

### 1B. Funnel all memory writes through one gate — closes **F5**
- **Touch**: 1 new function, 4 call-site rewrites.
- **Files**:
  - New: `src/memory/write-safely.ts` — `writeMemorySafely({content, source, target, threshold})` that runs `normalize → checkMemoryTaint(threshold) → sanitizeForMemory → redactKnownSecrets → write`. Caller passes `source: "tool" | "eot" | "auto-extract" | "sync"`; threshold defaults to strict (0.3) and EOT/auto-extract can raise it explicitly but cannot skip the chain.
  - Update: [`src/memory/tools/save.ts`](src/memory/tools/save.ts) — call `writeMemorySafely`.
  - Update: [`src/memory/end-of-turn-write.ts`](src/memory/end-of-turn-write.ts) — call `writeMemorySafely`; this *adds* the taint check that's currently missing.
  - Update: [`src/memory/auto-extract.ts`](src/memory/auto-extract.ts) — call `writeMemorySafely`; replaces the warn-only check with a block-on-threshold.
  - Update: [`src/memory/personality.ts`](src/memory/personality.ts) — route `IDENTITY.md` writes through `writeMemorySafely` instead of raw `atomicWriteFileSync`.
- **Migration risk**: EOT and auto-extract may have been silently writing tainted content that the strict gate will now block. Run with `LAX_MEMORY_WRITE_AUDIT=1` for one session before flipping enforcement, capture the would-have-blocked deltas, eyeball them, then enforce.
- **Done when**: grep for direct `appendDailyLog(`, `writeMemoryFile(`, `atomicWriteFileSync.*IDENTITY` outside `write-safely.ts` returns zero hits. Removing the taint call inside `write-safely.ts` fails a new unit test that proves an injection string is rejected.
- **Symptoms collapsed**: **A** (silent bypass via EOT), **D** (three taint behaviors → one).
- **Reversibility**: revert restores all three direct paths.

### 1C. Lift the tool gate chain to a shared pre-dispatch — closes **F3** (partial; full collapse in 2C)
- **Touch**: 1 new module, 2 dispatch-site updates.
- **Files**:
  - New: `src/tools/pre-dispatch.ts` — `assertToolCallAllowed(call, ctx)` runs the existing layers in order: `securityLayer.evaluate → checkSessionPolicy → toolPolicy.evaluate → threatEngine.preCheck → approvalManager.gate`. Throws a typed `ToolBlocked` error on first deny. Returns `void` on allow.
  - Update: [`src/tool-executor.ts:executeSingleTool`](src/tool-executor.ts) — replace the chained ifs inside the function with one `await assertToolCallAllowed(call, ctx)`. No behavior change for chat-path.
  - Update: [`packages/arikernel/tool-executors/src/base.ts`](packages/arikernel/tool-executors/src/base.ts) (or wherever `ToolExecutor.execute` lives) — call `assertToolCallAllowed` at the top. **This is the behavior-changing edit** — previously the arikernel path skipped approval entirely; after this it doesn't.
- **Done when**: a unit test calls a high-risk tool through the arikernel dispatcher and the approval manager fires. Removing the `assertToolCallAllowed` call from `arikernel/tool-executors/src/base.ts` makes the test fail.
- **Symptoms collapsed**: **A** (arikernel bypass closed).
- **Open after this**: the *registry* and *dispatcher* are still doubled — that's 2C. But the gate chain is no longer optional.
- **Reversibility**: trivial revert.

### 1D. Release-blocker housekeeping — closes **F15 partial**
- **Touch**: 2 small edits, no logic.
- **Files**:
  - Update: [`SECURITY.md`](SECURITY.md) — replace `[TBD - add security contact email]` with a real address.
  - New: `README.md` (stub) — name, one-paragraph what-it-is, link to `install.sh`/`install.ps1`/`install.bat`, link to [`AGENTS.md`](AGENTS.md). Full setup consolidation happens in 4C; this is a stub so a fresh contributor has *any* entry point.
- **Done when**: `SECURITY.md` no longer contains `[TBD`; `README.md` exists at repo root.
- **Symptoms collapsed**: external-facing release blocker. No internal symptom class — this is a paper cut.

---

**End-of-Phase-1 state**:
- AriKernel-path tool calls now hit approval. (A)
- All memory writes go through one gate; EOT no longer silently writes tainted content. (A, D)
- Adding the next provider id fails the build in every relevant file until updated everywhere. (C)
- Repo has a README and a real security contact.

---

## Phase 2 — Runtime convergence

**Why second**: the biggest structural collapse. Depends on Phase 1's shared gate (1C) being in place so the consolidated dispatcher in 2C has the pre-dispatch hook to call.

### 2A. Single `TERMINAL_STATES` constant — closes **F13**
- **Touch**: 1 new constant, 4 import-and-delete-local.
- **Files**:
  - New: `src/canonical-loop/terminal-states.ts` — `export const TERMINAL_STATES = ["succeeded","failed","cancelled"] as const; export type TerminalState = typeof TERMINAL_STATES[number];`
  - Update: [`canonical-loop/chat-runner.ts:59`](src/canonical-loop/chat-runner.ts#L59), [`agent-runner.ts:53`](src/canonical-loop/agent-runner.ts#L53), [`control-api.ts:184`](src/canonical-loop/control-api.ts#L184) — import.
  - Update: [`src/agents/run.ts:47`](src/agents/run.ts#L47) — switch from `{done, error, cancelled, timeout}` to `TerminalState`. `done → succeeded`, `error → failed`, `timeout → failed` with a `reason: "timeout"` field. Migrate any persistence/log shape with a small backfill.
- **Done when**: grep for `"done"` and `"timeout"` as run-state literals returns zero hits.
- **Symptoms collapsed**: **B** (one place to add a state), **D** (canonical and handler speak the same vocabulary — prerequisite for 2B).
- **Reversibility**: revert + migrate logs back. Cheap.

### 2B. Route `invokeAgent` + primal-auto-build through `runAgentViaCanonical` — closes **F1**
- **Touch**: 2 entry-point rewrites, 1 deprecation.
- **Files**:
  - Update: [`src/agents/invoke.ts`](src/agents/invoke.ts) — `invokeAgent(id, task)` now constructs a canonical op and calls `runAgentViaCanonical`. Same event shape exposed via an adapter that bridges canonical events to the existing EventBus signals (so primal-auto-build's existing subscriber code keeps working).
  - Update: [`src/primal-auto-build/orchestrator/`](src/primal-auto-build/orchestrator/) chunk-runner — call the new `invokeAgent` (no change in primal's own code; the change is below it).
  - Mark deprecated: [`src/agency/handler.ts`](src/agency/handler.ts) `runAgentAsync`. Add a deprecation comment naming the replacement. Don't delete yet — let it sit one release, then delete in a follow-up.
- **Done when**: an agent crash in primal-auto-build's chunk worker is recoverable from `op_events.jsonl`; tests can replay a previously-Handler-only run from disk; `invokeAgent` returns the same shape it used to.
- **Symptoms collapsed**: **D** (chat and agents have parity persistence/recovery), **F** (Handler enters the deletion queue).
- **Reversibility**: revert restores the old path. Handler still exists, so revert is clean.

### 2C. One tool registry + one dispatcher — closes **F2** and **F4**
- **Touch**: this is the biggest piece of work in the plan. Split into sub-commits.

**2C.1 — Unify the registry.**
- New: `src/tools/registry.ts` — single source. Tool definition shape supports both chat-path metadata (description, parameters JSON schema, deferred-tag) and arikernel metadata (`ToolClass` for legacy callers). MCP tools register into this same registry at startup.
- Update: [`src/tools/registry-build.ts`](src/tools/registry-build.ts) and [`src/tool-search.ts`](src/tool-search.ts) become thin adapters over the new registry. Eventually deleted; for this commit they re-export.
- Update: [`packages/arikernel/tool-executors/src/registry.ts`](packages/arikernel/tool-executors/src/registry.ts) — `ExecutorRegistry` becomes a *view* on the unified registry filtered by `ToolClass`.

**2C.2 — Unify policy.**
- New: `src/tool-policy/evaluator.ts` — one evaluator with a rule-pack interface. Rule packs: `defaultPolicyPack` (current `src/tool-policy/default-rules.ts`), `securityLayerPack` (current `src/security/layer-core.ts` checks), `arikernelPack` (current `packages/arikernel/policy-engine/src/defaults.ts`). Same schema (Zod). The pre-dispatch hook from 1C now calls `evaluator.evaluate(call, packs)` instead of chaining four independent calls.

**2C.3 — Collapse the dispatcher.**
- The chat-path `executeSingleTool` and the arikernel-path `ToolExecutor.execute` become one function: input `ToolCall`, output `ToolResult`. The arikernel-specific tool implementations (file, http, shell, database) get registered as tools in the unified registry with their original handlers. They lose their separate execution stack.
- AriKernel-specific behaviors (capability tokens, taint labels) become *fields* on the tool result envelope, not a separate execution path.

- **Done when**: grep for `ExecutorRegistry`, `executorRegistry.get`, `executeViaArikernel`-style symbols outside the unified registry returns zero hits. A new tool definition compiles to a single registration, callable from both chat and any current arikernel caller.
- **Symptoms collapsed**: **A** (only one dispatch path exists, so only one place can skip a gate — and the gate from 1C runs there), **B** (one place to add a tool, one place to add a policy rule), **E** ("where does X live" answered for tools + policy), **F** (the arikernel dispatcher path retires).
- **Reversibility**: each sub-commit is independently revertible. 2C.3 is the heaviest; tag the commit so we can `git revert` cleanly if integration surprises emerge.
- **Risk**: this is the work most likely to surface a hidden behavior dependency in arikernel callers. Plan a soak in a non-default branch for a day before merging.

### 2D. Credential patterns + scrubber consolidation — closes **F11**
- **Touch**: 1 new module, 2 scrubber rewrites.
- **Files**:
  - New: `src/security/credential-patterns.ts` — single `CREDENTIAL_PATTERNS` array (env-var prefixes + key-shape regexes), plus a `redact(str)` helper.
  - Update: [`src/hooks/hook-engine.ts`](src/hooks/hook-engine.ts) `scrubEnv` — consumes `CREDENTIAL_PATTERNS`.
  - Update: [`src/security/credentials.ts`](src/security/credentials.ts) `redactCredentials` — consumes the same patterns.
  - Optional: a thin `getCredential(name)` facade over vault/auth-file/env so callers don't open-code precedence. Out of scope if it expands the diff; defer.
- **Done when**: grep for `sk-ant-`, `ghp_`, `xai-`, etc. as regex literals outside `credential-patterns.ts` returns zero hits.
- **Symptoms collapsed**: **B** (one list), **D** (scrubbers can't drift).
- **Reversibility**: trivial.

---

**End-of-Phase-2 state**:
- One agent runtime path. Handler deprecated. (D, F)
- One tool registry, one dispatcher, one policy evaluator, one approval gate. AriKernel becomes a tag/pack inside the unified system, not a parallel stack. (A, B, E, F)
- Run-state vocabulary unified. (B, D)
- Credential patterns unified. (B, D)

---

## Phase 3 — Provider + voice consolidation

**Why third**: high impact on dev velocity, but lower risk than Phase 2's runtime collapse. Can run in parallel with Phase 4 once Phase 2 lands.

### 3A. `src/providers/registry.ts` — closes **F8** and **F10**
- **Touch**: 1 new module, N call-site swaps (~5 files in src + 2 in public/).
- **Anthropic is special — not a drift target.** Anthropic OAuth must route through the Claude CLI subprocess; direct HTTP fails for Sonnet/Opus on the Max plan. The registry has to discriminate on transport, not assume every provider fits a `{baseURL, envKey}` shape. Don't try to "unify" Anthropic into the OpenAI-compat path — that's the bug, not the fix.
- **Files**:
  - New: `src/providers/registry.ts` — `PROVIDERS: Record<ProviderId, ProviderMeta>` where `ProviderMeta` is a **discriminated union on `transport`**:
    - `{transport: "http", id, label, models, defaultModel, baseURL, envKey, capabilities}` — for the OpenAI-compatible family (openai, xai, cerebras, gemini, ollama-cloud, local, codex, custom).
    - `{transport: "cli", id: "anthropic", label, models, defaultModel, cliBinary, capabilities}` — for Anthropic. No `baseURL`, no `envKey`; the subprocess owns auth.
    The reasoning regex from [`openai-http.ts:21`](src/providers/adapters/openai-http.ts#L21) moves here as a per-provider `capabilities.reasoning` flag.
  - Update: [`src/agent-request/resolve-provider.ts`](src/agent-request/resolve-provider.ts) — `defaultModelFor(id)` reads from registry; `hasCredsFor` reads `envKey`.
  - Update: [`src/routes/settings/providers.ts`](src/routes/settings/providers.ts) — provider list, DEFAULT_MODEL, UI labels read from registry.
  - Update: [`src/canonical-loop/adapters/openai-compat.ts:548`](src/canonical-loop/adapters/openai-compat.ts#L548) — replace the `if (provider === "cerebras")` chain with `PROVIDERS[provider].baseURL`.
  - Update: [`public/js/apps.js`](public/js/apps.js) and [`public/app.html`](public/app.html) — fetch the provider list from a small endpoint that returns the registry instead of hardcoding it. (If this proves heavier than it sounds, leave the HTML alone for now and just unify the backend; HTML stays a known-stale shadow until the UI rebuild.)
- **Done when**: adding `"groq"` requires editing one file (`registry.ts`) and the build picks it up everywhere — UI dropdown, resolver, baseURL routing, type union (via 1A's derivation).
- **Symptoms collapsed**: **B** (N-file dance dies for providers), **E**.
- **Reversibility**: trivial. The registry shape is additive.

### 3B. ~~Flip `LAX_VOICE_OPEN=1` and migrate to open-voice library — closes F9~~
**DROPPED 2026-05-13.** F9 was reclassified to "intentional divergence" after discovering the `open-voice` library was a shelved alternative, not a migration target. The library was never installed as a project dependency and the three-tier sidecar (tier4 / gpu-session / realtime) is the canonical voice path. The 3B.1 commit that landed this morning was reverted (6793aed); the 3B.1b wiring branch was dropped without merging. See the audit's tolerable shelf for the corrected F9 entry. Phase 3 now contains only 3A.

---

**End-of-Phase-3 state**:
- One provider registry. Adding a provider = one file. (B, E)

---

## Phase 4 — Doc reconciliation

**Why last**: low-risk paperwork. Can land any time after Phase 1's release-blocker housekeeping (1D). Often best done in parallel with Phase 2/3 when the engineer needs a context-switch break.

### 4A. Reconcile AUDIT* docs — closes **F7**
- **Touch**: move + edit, no code.
- **Action**:
  - Make [`AUDIT-STATE.md`](AUDIT-STATE.md) the live SOT — add a "Status: complete (2026-05-12)" header explicitly, link to the other three.
  - Move `AUDIT.md`, `AUDIT-PLAN.md`, `AUDIT-HANDOFF-P4.md` to `docs/audits/2026-05-canonical-refactor/`.
  - At repo root, leave a 5-line `AUDIT-STATE.md` pointing to the archive + a one-line current status.
- **Done when**: a fresh contributor reading any single root-level doc knows the refactor is complete.
- **Symptoms collapsed**: **E**.
- **Reversibility**: `git mv` reverts.

### 4B. Split SECURITY.md / THREAT-MODEL.md — closes **F12**
- **Touch**: edit both, possibly extract a shared section.
- **Action**:
  - [`SECURITY.md`](SECURITY.md) becomes user-facing: reporting policy, SLAs, contact (already set in 1D), link to threat model.
  - [`THREAT-MODEL.md`](THREAT-MODEL.md) becomes design-internal: actors, surfaces, layer architecture.
  - Optional: extract the layer-architecture section into `docs/security/defense-layers.md` and link from both — only if the section ends up referenced from 3+ places.
- **Done when**: layer numbering exists in exactly one place; both root docs link there instead of restating it.
- **Symptoms collapsed**: **E**, drift prevention.
- **Reversibility**: trivial.

### 4C. README + shared install core — closes **F15** (main)
- **Touch**: 1 README expansion, 1 new script, 3 wrapper rewrites.
- **Files**:
  - Expand the Phase-1 stub README to: project description, prerequisites, install commands (one per OS), test/dev commands, link to AGENTS.md for contributor invariants, link to AUDIT-STATE.md for refactor context.
  - New: `scripts/install-common.mjs` — the actual install logic (Node version check, deps, voice-models fetch if applicable, env-file scaffold).
  - Update: `install.bat`, `install.ps1`, `install.sh` — become thin wrappers that invoke `node scripts/install-common.mjs` after the OS-specific bootstrap (Node availability check).
- **Done when**: changing the install procedure requires editing one file, not three.
- **Symptoms collapsed**: **B**, **E**, **F** (no more silent drift between three install scripts).
- **Reversibility**: trivial.

---

**End-of-Phase-4 state**:
- One canonical doc per topic. Audit history archived, not duplicated. (E)
- One install logic, three thin OS wrappers. (B, F)
- Public-facing repo presentable: README, real security contact, no `[TBD]` placeholders.

---

## What stays duplicated, on purpose

Per the audit's tolerable/intentional/false-positive shelf:

- **Anthropic CLI proxy path vs OpenAI-compatible HTTP adapters.** Different transports by design. Direct HTTP fails for Sonnet/Opus on the Max plan, so Anthropic rides through the Claude CLI subprocess. Not drift, not a refactor target. The new `providers/registry.ts` discriminates on `transport: "http" | "cli"` so this divergence is named in code, not buried in an `if (provider === "anthropic")` branch.
- **Voice clause-chunker / preroll / playback-tracker (F9, reclassified 2026-05-13).** The `open-voice` library at `C:\Users\manri\open-voice` was an alternative voice toolkit that got shelved when the three-tier sidecar approach (tier4 ONNX Kokoro / gpu-session / realtime) proved adequate. The library is not installed as a project dependency. The "duplication" between `voice-session.ts`/`gpu-session.ts` and the open-voice modules is deliberate divergence from a parked alt-path — leave it. The `integrations/open-voice/bridge.ts` file is dead code from when the migration was still planned; safe to delete in a future cleanup pass.
- Retry/backoff across `auto-retry`, `tool-executor`, `workers/heartbeat`, `canonical-loop/worker`, `circuit-breaker` — different layers, different decisions. Don't collapse.
- `src/providers/adapter/` (interface) vs `src/providers/adapters/` (impls) — not duplication. Optional cosmetic rename if the singular-vs-plural footgun bothers you; otherwise leave.
- `src/agent-loop/inject-queue.ts` — micro-module; only the *directory name* is misleading. Optional rename to `src/inject-queue/`.
- `BUGS-FOUND.md`, `IMPLEMENTATION-REPORT.md`, `THINGS-TO-CLEAN-BEFORE-RELEASE.md` — three orthogonal lists, no overlap.
- `src/embedding-providers/` wiring — pass-by-parameter is intentional; no global to drift.
- `docs/` design specs — predate or specify the canonical work; not duplicating findings.

---

## Sequencing summary

| Phase | Closes | Symptom classes | Risk | Reversible? |
|---|---|---|---|---|
| 1A | F6 | C, B | Low | Yes |
| 1B | F5 | A, D | Medium (may surface previously-silent injections) | Yes |
| 1C | F3 | A | Low (behavior addition only) | Yes |
| 1D | F15 partial | — (release-blocker) | None | Yes |
| 2A | F13 | B, D | Low | Yes + log backfill |
| 2B | F1 | D, F | Medium | Yes |
| 2C | F2, F4 | A, B, E, F | High (biggest collapse) | Yes per-sub-commit |
| 2D | F11 | B, D | Low | Yes |
| 3A | F8, F10 | B, E | Low | Yes |
| ~~3B~~ | ~~F9~~ | — | **Dropped 2026-05-13 — F9 reclassified as intentional** | — |
| 4A | F7 | E | None | Yes |
| 4B | F12 | E | None | Yes |
| 4C | F15 main | B, E, F | None | Yes |

Total: ~20 commits across 13 phase entries. Phase 1 is one afternoon. Phase 2 is the actual structural week. Phase 3 is two more focused sessions. Phase 4 fills any gaps.

---

## Done check for the whole plan

You can declare DRY victory when:

1. Adding a provider requires editing one file (`providers/registry.ts`) — the build picks it up in resolver, UI dropdown, baseURL routing, type union.
2. Adding a tool requires one registration; the gate chain (taint → policy → threat → approval) runs without the registering code mentioning it.
3. Any agent run — chat, `invokeAgent`, primal-auto-build chunk worker, cron mission — is recoverable from `op_events.jsonl` and uses the same terminal-state vocabulary.
4. A prompt-injection string fails to land in memory regardless of whether it arrived via the tool, EOT classifier, auto-extract, or sync pull.
5. A fresh contributor reading the root-level docs can name the project, install it, find the threat model, and find the audit status from one starting point each.
6. `git grep` for the symbols `ExecutorRegistry`, `runAgentAsync`, and `[TBD` returns zero hits. (The `SENTENCE_TERMINATOR` regex stays in voice files — see F9 on the audit's tolerable shelf.)
