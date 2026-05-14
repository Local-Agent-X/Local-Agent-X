# DRY Repair — Dispatch Prompts

Companion to [DRY-AUDIT.md](DRY-AUDIT.md) and [DRY-REPAIR-PLAN.md](DRY-REPAIR-PLAN.md).

Each section below is a **complete, self-contained prompt** to copy-paste into a fresh Claude Code session. Sessions report back to `docs/dry-repair-reports/<task-id>.md` and Peter feeds the report to the orchestrator session.

---

## Parallel-safety map

**Group A — safe to fan out RIGHT NOW (no file overlap, no semantic conflict):**

| Task | Closes | Files touched | Size |
|---|---|---|---|
| 1A | F6 | 1 new + 4 edits | small |
| 1B | F5 | 1 new + 4 edits (memory only) | medium |
| 1C | F3 | 1 new + 2 edits | small |
| 1D | F15p | 2 docs | tiny |
| 2A | F13 | 1 new + 4 edits | small |
| 2D | F11 | 1 new + 2 edits | small |
| 3B.1 | F9 (kicks soak) | 1 edit | tiny |
| 4A | F7 | doc moves only | tiny |

All 8 touch disjoint files. Merge order within Group A doesn't matter.

**Group B — wait for the named Group-A task to land first:**

| Task | Needs | Closes |
|---|---|---|
| 2B | 2A merged | F1 |
| 2C.1 / 2C.2 / 2C.3 | 1C merged | F2, F4 |
| 3A | 1A merged | F8, F10 |
| 3B.2 | 3B.1 soak passed | F9 (deletion) |
| 4B | 1D merged | F12 |
| 4C | 1D merged | F15 main |

---

## Reporting convention

Every session writes its report to `docs/dry-repair-reports/<task-id>.md` with:

```markdown
# <task-id>: <name>
Closes: F<N>
Status: completed | partial | blocked

## Files changed
- path/to/file.ts — one-line what changed

## Acceptance check
[passed | failed | partial]
<evidence: command output, test result, grep result, etc.>

## Surprises / scope concerns
- ...

## Adjacent findings noticed but NOT fixed
- ...
```

---

# Group A prompts

---

## TASK 1A — Derive `ProviderId` from runtime list

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Read first:
- CLAUDE.md (user's global rules — MUST follow)
- AGENTS.md (project invariants)
- DRY-AUDIT.md → Finding F6
- DRY-REPAIR-PLAN.md → Phase 1A

Task: Close F6 — provider-ID type drift. Two type files are missing
"cerebras" and "ollama-cloud" even though resolve-provider.ts accepts them.

What to do (verbatim from plan §1A):
1. Create src/providers/provider-ids.ts with:
     export const PROVIDER_IDS = [
       "codex","xai","openai","anthropic","local",
       "ollama-cloud","gemini","cerebras","custom"
     ] as const;
     export type ProviderId = typeof PROVIDER_IDS[number];

2. Update src/agent-request/resolve-provider.ts:36 — import PROVIDER_IDS,
   drop local VALID array.

3. Update src/providers/types.ts:18 — replace the union literal with
   the imported ProviderId.

4. Update src/model-fallback.ts:28 — replace local ProviderId with
   the shared one.

5. Update src/routes/settings/providers.ts — use PROVIDER_IDS where
   the array literal is built (verify it still satisfies the runtime shape).

CRITICAL: Anthropic OAuth routes through the Claude CLI subprocess, not
direct HTTP. The provider-ID list includes "anthropic" but its transport
is different from the OpenAI-compat family. Do NOT touch that distinction
in this task — you're only unifying the IDENTIFIER LIST.

Constraints:
- Match existing code style. Read each file before editing.
- No comments/docstrings/types added to code you don't touch.
- No file over 400 LOC after your edit.
- Stay in scope. If you notice F8/F10 (provider registry) needs work,
  flag it — don't fix it.

Acceptance check (run before reporting):
- npm run typecheck (or tsc --noEmit) passes
- Adversarial: temporarily delete "cerebras" from PROVIDER_IDS — the
  build must fail in resolve-provider.ts, providers/types.ts, and
  model-fallback.ts. Restore it after.
- grep for hardcoded provider-union literals (the string
  '"xai" | "openai" | "codex"' or similar) — should return zero hits
  outside provider-ids.ts.

Commit message: "refactor(providers): derive ProviderId from runtime list (closes F6)"
Do NOT push.

Report to: docs/dry-repair-reports/1A.md
Use the report template from DRY-REPAIR-PROMPTS.md.
```

---

## TASK 1B — Funnel all memory writes through one safety gate

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Read first:
- CLAUDE.md (user's global rules — MUST follow)
- AGENTS.md (project invariants)
- DRY-AUDIT.md → Finding F5
- DRY-REPAIR-PLAN.md → Phase 1B
- src/sanitize.ts (understand checkMemoryTaint, sanitizeForMemory,
  redactKnownSecrets, MEMORY_INJECTION_PATTERNS vs INJECTION_PATTERNS)

Task: Close F5 — three memory write paths with three different taint gates.
memory_save blocks at score ≥0.3; end-of-turn-write does NO taint check;
auto-extract only logs a warning. All three reach the same files.

What to do (verbatim from plan §1B):

1. Create src/memory/write-safely.ts exporting:
     writeMemorySafely({
       content: string,
       source: "tool" | "eot" | "auto-extract" | "sync" | "personality",
       target: string,           // file path or memory key
       threshold?: number,        // default 0.3 (strict)
       mode?: "append" | "overwrite"
     })
   Internal pipeline (in order, every time):
     normalize → checkMemoryTaint(threshold) → sanitizeForMemory
     → redactKnownSecrets → write
   Throws a typed `MemoryWriteBlocked` error if the taint check fails.
   Callers can RAISE the threshold but cannot skip the chain.

2. Rewrite call sites:
   - src/memory/tools/save.ts → call writeMemorySafely (replaces inline gate)
   - src/memory/end-of-turn-write.ts → call writeMemorySafely
     (this ADDS the taint check that's currently missing)
   - src/memory/auto-extract.ts → call writeMemorySafely
     (replaces warn-only with block-on-threshold)
   - src/memory/personality.ts → route IDENTITY.md writes through
     writeMemorySafely instead of raw atomicWriteFileSync

3. Migration audit mode: gate the new strict block behind
   LAX_MEMORY_WRITE_AUDIT=1 (env). When the env is set, the gate
   logs would-have-blocked deltas to logs/memory-write-audit.log
   but does not block. Default (env unset) = strict block.
   This lets Peter do one soak session before flipping enforcement.

Constraints:
- Don't touch sanitize.ts implementation. You're funneling, not rewriting
  the gate logic.
- No file over 400 LOC after your edit. write-safely.ts should stay small;
  if it grows past 200 LOC, you're doing too much.
- Stay in scope. If sanitize.ts has bugs, flag — don't fix.

Acceptance check (run before reporting):
- npm run typecheck passes
- Unit test: write a tainted string via writeMemorySafely → it throws
  MemoryWriteBlocked. Remove the checkMemoryTaint call inside
  writeMemorySafely → test fails.
- grep for direct calls to appendDailyLog(, writeMemoryFile(,
  atomicWriteFileSync.*IDENTITY outside write-safely.ts → zero hits.
- LAX_MEMORY_WRITE_AUDIT=1 set → soak mode active, logs created.

Commit message: "refactor(memory): funnel writes through writeMemorySafely (closes F5)"
Do NOT push.

Report to: docs/dry-repair-reports/1B.md
```

---

## TASK 1C — Lift the tool-gate chain to a shared pre-dispatch function

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Read first:
- CLAUDE.md (user's global rules — MUST follow)
- AGENTS.md (project invariants)
- DRY-AUDIT.md → Finding F3 (security-relevant)
- DRY-REPAIR-PLAN.md → Phase 1C
- src/tool-executor.ts (specifically the gate chain around L351–586)
- src/approval-manager.ts
- src/security/layer-core.ts
- src/threat/tool-chain.ts
- src/tool-policy/ (default-rules.ts and friends)
- packages/arikernel/tool-executors/src/base.ts (the OTHER dispatcher
  that currently SKIPS approval entirely)

Task: Close F3 — the AriKernel-path tool dispatcher bypasses the approval
gate. The chat-path runs a chain (security → policy → threat → approval),
the AriKernel path runs only policy-engine. Lift the chain to a shared
function both must call.

What to do (verbatim from plan §1C):

1. Create src/tools/pre-dispatch.ts exporting:
     assertToolCallAllowed(call: ToolCall, ctx: ToolCtx): Promise<void>
   Runs in order:
     securityLayer.evaluate → checkSessionPolicy → toolPolicy.evaluate
     → threatEngine.preCheck → approvalManager.gate
   Throws a typed `ToolBlocked` error (with stage and reason) on first deny.
   Returns void on allow.

2. Update src/tool-executor.ts: replace the inline chain inside
   executeSingleTool with one `await assertToolCallAllowed(call, ctx)`.
   No behavior change for chat-path (same checks, same order).

3. Update packages/arikernel/tool-executors/src/base.ts (the
   ToolExecutor base class that the file/http/shell/database executors
   extend): call assertToolCallAllowed at the top of execute().
   This IS a behavior change — the AriKernel path previously skipped
   approval entirely. Now it doesn't.

CRITICAL: The point of this task is that BOTH dispatchers call the same
gate function. Don't unify the dispatchers themselves — that's task 2C.
You're just lifting the gate.

Constraints:
- pre-dispatch.ts must be small. <150 LOC.
- Don't change the underlying policy logic. You're factoring, not redesigning.
- Don't touch the registry — that's 2C.
- If a layer (security/policy/threat) needs a new shape to be callable
  from both paths, prefer an adapter at the call site over rewriting the layer.

Acceptance check (run before reporting):
- npm run typecheck passes
- Write a focused test: instantiate an AriKernel ToolExecutor, invoke a
  tool that requires approval, with approvalManager mocked to record calls.
  Assert approvalManager.gate was called. Then remove assertToolCallAllowed
  from base.ts → test fails.
- Chat-path regression: existing tool-executor tests still pass.

Commit message: "refactor(tools): lift gate chain to assertToolCallAllowed (closes F3)"
Do NOT push.

Report to: docs/dry-repair-reports/1C.md
```

---

## TASK 1D — README stub + SECURITY contact email

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-REPAIR-PLAN.md → Phase 1D

Task: Release-blocker housekeeping. SECURITY.md has "[TBD - add security
contact email]"; repo has no README. This task fixes both with minimum
content. The FULL README is task 4C — you're writing only a stub.

What to do:

1. Update SECURITY.md — replace "[TBD - add security contact email]"
   with petermanrique101@gmail.com (Peter's email, confirmed).

2. Create README.md at repo root. Stub contents (and only this much):
   - H1: "Local Agent X"
   - One paragraph: what it is (a self-hosted agent platform you run
     on your own machine, supports multiple LLM providers, voice,
     scheduled missions, app builds). One sentence each.
   - "## Install" section pointing at install.bat / install.ps1 / install.sh
     by OS (1 line each, no commentary).
   - "## Status" section: one sentence noting active development +
     a link to AUDIT-STATE.md.
   - "## For contributors" section: one sentence pointing at AGENTS.md.
   - Nothing else. Task 4C expands this.

Constraints:
- No marketing copy. Plain, direct prose.
- No mention of Claude/Anthropic/AI tools in the README itself.
- README ≤80 lines.

Acceptance check:
- grep "[TBD" SECURITY.md → zero hits
- README.md exists, is ≤80 lines, contains the four sections above

Commit message: "docs: add README stub and SECURITY contact email (closes F15 partial)"
Do NOT push.

Report to: docs/dry-repair-reports/1D.md
```

---

## TASK 2A — Single `TERMINAL_STATES` constant

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F13
- DRY-REPAIR-PLAN.md → Phase 2A
- src/canonical-loop/chat-runner.ts, agent-runner.ts, control-api.ts
- src/agents/run.ts

Task: Close F13 — terminal-state vocabulary drift. Canonical loop uses
{succeeded, failed, cancelled}; src/agents/run.ts uses
{done, error, cancelled, timeout}. Different words for the same states.

What to do (verbatim from plan §2A):

1. Create src/canonical-loop/terminal-states.ts:
     export const TERMINAL_STATES = ["succeeded","failed","cancelled"] as const;
     export type TerminalState = typeof TERMINAL_STATES[number];

2. Update canonical-loop/chat-runner.ts:59, agent-runner.ts:53,
   control-api.ts:184 — import TERMINAL_STATES, drop the redeclared sets.

3. Update src/agents/run.ts:47 — switch from {done, error, cancelled, timeout}
   to TerminalState. Mapping:
     done    → succeeded
     error   → failed
     timeout → failed + { reason: "timeout" } field on the run record
     cancelled → cancelled
   Add the `reason` field to the run record type if it's not already there.

4. Backfill: any persisted log/state shape that records the old strings —
   write a one-shot migration (or leave it if logs are write-only and
   readers tolerate both — your call, but document it in the report).

Constraints:
- This is foundation work for task 2B (route invokeAgent through canonical),
  which is being dispatched after this lands. Don't try to do 2B's work.
- If a caller compares run.status to "done" or "timeout" as a string,
  find every such call site and update it. grep "done"|"timeout" in the
  context of run state — many false positives, filter carefully.

Acceptance check:
- npm run typecheck passes
- grep for `"done"` and `"timeout"` as run-state literals → zero hits
  (be careful with false positives: tool names like "task_done" don't count)
- Existing tests on the canonical loop still pass

Commit message: "refactor(loop): unify terminal-state vocabulary (closes F13)"
Do NOT push.

Report to: docs/dry-repair-reports/2A.md
```

---

## TASK 2D — Credential pattern consolidation

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F11
- DRY-REPAIR-PLAN.md → Phase 2D
- src/hooks/hook-engine.ts (specifically scrubEnv and its SCRUB_KEYS)
- src/security/credentials.ts (redactCredentials and its regex set)

Task: Close F11 — two scrubbers, two divergent pattern lists. Hook scrubber
catches env-var prefixes (ANTHROPIC_, OPENAI_, ...); security redactor
catches key-shape regexes (sk-ant-, ghp_, ...). A new key shape added to
one will silently miss the other.

What to do (verbatim from plan §2D):

1. Create src/security/credential-patterns.ts exporting:
     // Env-var name prefixes considered credential-bearing
     export const CREDENTIAL_ENV_PREFIXES: RegExp = /^(ANTHROPIC_|OPENAI_|XAI_|CEREBRAS_|GROQ_|MISTRAL_|VOYAGE_|GOOGLE_|GEMINI_|AZURE_|HF_|GH_|GITHUB_|SLACK_|NOTION_|...)/;
     // Inline secret-shape regexes
     export const CREDENTIAL_KEY_PATTERNS: RegExp[] = [
       /\bsk-ant-[a-zA-Z0-9_-]{20,}/g,
       /\bsk-[a-zA-Z0-9]{20,}/g,
       /\bghp_[a-zA-Z0-9]{30,}/g,
       /\bxai-[a-zA-Z0-9]{20,}/g,
       ...
     ];
     export function redact(str: string): string { ... }
   Consolidate from both existing files. Keep the UNION of patterns —
   neither current scrubber catches everything; the consolidated list should.

2. Update src/hooks/hook-engine.ts — scrubEnv consumes CREDENTIAL_ENV_PREFIXES.

3. Update src/security/credentials.ts — redactCredentials consumes
   CREDENTIAL_KEY_PATTERNS (and re-exports redact() if useful).

Constraints:
- Don't change scrubber CALLERS. You're factoring the patterns, not
  the call sites.
- Out of scope: the unified getCredential(name) facade over vault/auth/env.
  Plan §2D notes this is deferred.

Acceptance check:
- npm run typecheck passes
- grep for the literal regexes `/sk-ant-/`, `/ghp_/`, `/xai-/` etc.
  outside credential-patterns.ts → zero hits.
- Unit test (add one): a test string containing a fake sk-ant-XXXX gets
  redacted by BOTH scrubEnv (after env-shape conversion) and redact().
- Hook scrubber and security redactor produce the same coverage on a
  fixture file containing one example of every pattern in the union.

Commit message: "refactor(security): consolidate credential patterns (closes F11)"
Do NOT push.

Report to: docs/dry-repair-reports/2D.md
```

---

## TASK 3B.1 — Flip `LAX_VOICE_OPEN` default to 1 (kicks off soak)

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F9
- DRY-REPAIR-PLAN.md → Phase 3B
- integrations/open-voice/README.md (the migration intent)
- integrations/open-voice/bridge.ts (where the flag is read)
- src/voice/voice-session.ts (the LEGACY orchestrator — do NOT delete yet)

Task: Phase 3B is two-stage. THIS TASK is stage 1 — flip the default,
kick off a latency soak. Stage 2 (deleting the inline orchestration from
voice-session.ts/gpu-session.ts) waits for soak results.

What to do:

1. Find where LAX_VOICE_OPEN is read (likely integrations/open-voice/bridge.ts
   or src/voice/voice-session.ts). Change the default from "0" to "1"
   when the env is unset. KEEP the LAX_VOICE_OPEN=0 escape hatch — that
   is the revert button if soak finds a regression.

2. Add a one-line log on session start indicating which path is active:
   "voice-session: routing via open-voice (LAX_VOICE_OPEN=1)"
   "voice-session: routing via legacy in-tree (LAX_VOICE_OPEN=0)"

3. Do NOT touch the inline clause-chunker / preroll / playback code in
   voice-session.ts or gpu-session.ts. That's stage 2 (task 3B.2),
   gated on soak.

Constraints:
- Diff should be tiny — likely 3–10 lines of code change.
- Don't touch the open-voice bridge implementation.
- This is reversible by setting LAX_VOICE_OPEN=0 — make sure that path
  still works after your change.

Acceptance check:
- With no env set: voice session routes through open-voice bridge
  (verify the log line fires).
- With LAX_VOICE_OPEN=0 set: voice session uses the legacy path.
- npm run typecheck passes.

Commit message: "feat(voice): default LAX_VOICE_OPEN=1; legacy path remains via env escape (closes F9 stage 1)"
Do NOT push.

Report to: docs/dry-repair-reports/3B.1.md
Include in the report: a soak plan (what Peter should listen for,
what latency numbers are the gate from project memory:
~0.9–3s warm path on 3060 is the target).
```

---

## TASK 4A — Reconcile AUDIT* docs

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F7
- DRY-REPAIR-PLAN.md → Phase 4A
- AUDIT.md, AUDIT-PLAN.md, AUDIT-STATE.md, AUDIT-HANDOFF-P4.md

Task: Close F7 — four AUDIT* docs document ONE audit. AUDIT-PLAN.md reads
prospective; AUDIT-STATE.md says complete. State is split.

What to do (verbatim from plan §4A):

1. Add a clear "Status: complete (2026-05-12)" header to AUDIT-STATE.md
   (top of file). Make it unambiguous that the canonical refactor described
   here is DONE.

2. Create docs/audits/2026-05-canonical-refactor/ directory.

3. git mv AUDIT.md, AUDIT-PLAN.md, AUDIT-HANDOFF-P4.md into the new directory.

4. Replace root-level AUDIT-STATE.md with a 5–10-line summary:
   - Status: complete (2026-05-12)
   - One paragraph: what the refactor was (canonical-loop convergence)
   - Link to docs/audits/2026-05-canonical-refactor/ for the full record
   - Link to DRY-AUDIT.md / DRY-REPAIR-PLAN.md for the CURRENT effort

5. Inside docs/audits/2026-05-canonical-refactor/, add a one-line INDEX.md
   pointing at the three archived docs.

CRITICAL: This is a doc-only task. Don't touch code. Don't touch
DRY-AUDIT.md / DRY-REPAIR-PLAN.md / DRY-REPAIR-PROMPTS.md / SECURITY.md /
THREAT-MODEL.md — those are the CURRENT effort, separate from this archive.

Constraints:
- Use `git mv` not plain mv — preserve history.
- Keep the new root AUDIT-STATE.md under 60 lines.

Acceptance check:
- A reader landing on root AUDIT-STATE.md immediately knows the refactor
  is complete.
- AUDIT.md / AUDIT-PLAN.md / AUDIT-HANDOFF-P4.md are NOT at repo root.
- `git log --follow docs/audits/2026-05-canonical-refactor/AUDIT.md`
  shows history continuity.

Commit message: "docs(audit): archive completed canonical-refactor docs (closes F7)"
Do NOT push.

Report to: docs/dry-repair-reports/4A.md
```

---

# Group B prompts (start after the named dep lands)

**Branch isolation rule for every Group B session** (read before dispatching): each session's FIRST action is `git checkout -b dry-repair/<task-id>` off `main`. All work happens on that branch. The session's LAST action is a single `git commit` on that branch using the commit message named in the prompt. Do NOT push. Do NOT merge to main. Do NOT commit to main. Peter rebases / merges each branch into main at his cadence after reviewing.

This rule exists because two sessions earlier shared `main`'s working tree without intermediate commits and the changes had to be untangled by hand. Each Group B session owning a branch prevents that.

Every prompt below repeats this directive in its Constraints block — leaving it here at the top too for visibility when scanning the doc.

---

## TASK 2B — Route `invokeAgent` + primal-auto-build through `runAgentViaCanonical`

**Wait for: 2A merged** (needs TERMINAL_STATES type to exist).

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Prereq verified: TERMINAL_STATES type from task 2A is merged
(grep src/canonical-loop/terminal-states.ts — must exist).

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F1 (this is the biggest structural finding)
- DRY-REPAIR-PLAN.md → Phase 2B
- src/canonical-loop/ (specifically runAgentViaCanonical and its
  op_submit_async flow — understand what it produces in op_events.jsonl,
  op_messages.jsonl, op_turns.jsonl)
- src/agency/handler.ts (the SHADOW path; specifically runAgentAsync L304)
- src/agents/invoke.ts (current entry that calls Handler)
- src/primal-auto-build/orchestrator/ (sub-agent invocation chain;
  follow runChunkAgent → invokeDefinition → Handler)
- src/event-bus.ts or wherever Handler emits — you need to adapt those
  shapes from canonical events

Task: Close F1 — chat goes through canonical-loop (persisted, recoverable);
invokeAgent and primal-auto-build sub-agents go through agency/handler.ts
(in-memory EventBus, no audit trail). Route them through canonical.

What to do (verbatim from plan §2B):

1. Update src/agents/invoke.ts — invokeAgent(id, task) now constructs a
   canonical op (via op_submit_async semantics) and calls
   runAgentViaCanonical. KEEP the existing callable surface
   (signature, return shape).

2. Build a thin event-bridge: canonical events → existing EventBus
   signals (handler:agent-run, handler:agent-result, etc.) so primal-auto-
   build's subscriber code keeps working unchanged. This adapter is the
   migration safety belt.

3. Update src/primal-auto-build/orchestrator/ as needed if it calls
   into Handler directly anywhere. Verify all sub-agent spawns now ride
   canonical (grep for `runAgentAsync`, `Handler.spawnAgent`,
   `FieldAgent` — every call site needs to be either retired or routed).

4. Mark deprecated in src/agency/handler.ts: add a
   `@deprecated — replaced by runAgentViaCanonical, scheduled for deletion
   one release after 2026-05-13` comment on runAgentAsync. DO NOT DELETE.
   Let it sit for one release. Plan §2B is explicit on this — deletion
   is a follow-up task.

CRITICAL: Persistence parity is the actual point. After this, a crash
inside primal-auto-build's chunk worker must be recoverable from
op_events.jsonl. If you can't demonstrate that, the task isn't done.

Constraints:
- DO NOT delete handler.ts — deprecation only.
- The EventBus adapter is essential. Without it, primal-auto-build's
  subscribers go silent and you've broken the build loop.
- Pre-existing test suites for invokeAgent and primal must still pass.

Acceptance check:
- Existing primal-auto-build chunk tests still pass.
- New test: kill an in-flight agent run mid-tool-call, restart, verify
  recovery from op_events.jsonl.
- New test: invokeAgent('foo', task) returns the same shape it returned
  before this commit.
- grep for `runAgentAsync` in production code (not handler.ts itself):
  zero hits OR every remaining call site has a documented reason in
  the report.

Branch protocol (REQUIRED):
- First action this session: git checkout -b dry-repair/2B (off main).
- Do ALL work on that branch.
- Last action: ONE git commit on that branch with the message below.
- Do NOT push. Do NOT merge to main. Do NOT commit to main.

Commit message: "refactor(agents): route invokeAgent + primal through canonical (closes F1)"

Report to: docs/dry-repair-reports/2B.md
```

---

## TASK 2C.1 — Unify the tool registry

**Wait for: 1C merged.**

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Prereq verified: assertToolCallAllowed from task 1C is merged
(grep src/tools/pre-dispatch.ts — must exist).

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F2
- DRY-REPAIR-PLAN.md → Phase 2C (this task is sub-commit 2C.1 of 3)
- src/tools/registry-build.ts (allTools[] + buildToolRegistry)
- src/tool-search.ts (ToolRegistry class)
- packages/arikernel/tool-executors/src/registry.ts (ExecutorRegistry)
- src/mcp-client.ts (MCP catch-up registration)
- src/server/bootstrap-tools.ts (the dedup workaround)

Task: Close F2 part 1 — three tool registries become one. AriKernel
ToolClass-keyed registry becomes a VIEW on the unified registry, not a
parallel store. MCP tools register into the unified registry at startup
(not as a catch-up step).

What to do:

1. Create src/tools/registry.ts as the single source. Tool definition
   shape must accommodate:
   - Chat-path metadata: name, description, parameters (JSON schema),
     deferred-tag, MCP-source-tag
   - AriKernel metadata: optional `toolClass` field (mapped from the
     existing ToolClass enum) so the AriKernel side can filter

2. registry-build.ts and tool-search.ts become THIN re-exports of the
   new registry. Their public surface stays callable so callers don't
   break — they delegate to the new module.

3. packages/arikernel/tool-executors/src/registry.ts: ExecutorRegistry
   becomes a VIEW (function) that filters the unified registry by
   toolClass. It does NOT hold its own store of tools.

4. MCP tools: register directly into the unified registry at startup
   (in bootstrap-tools.ts) instead of being added separately after
   buildToolRegistry runs. The catch-up dedup workaround goes away.

CRITICAL: Don't unify the DISPATCHER yet. That's 2C.3. This task is
ONLY about the registry. Dispatchers still run separately — they just
read from the same place.

Constraints:
- Both old registry modules (registry-build, tool-search) keep working
  via delegation. Callers don't need to change.
- The unified registry must support deferred-tagging (used by
  bootstrap-tools to lazy-load tools).
- No file over 400 LOC.

Acceptance check:
- npm run typecheck passes.
- Existing tool-discovery tests pass.
- New test: register a tool with toolClass="shell"; verify it's
  visible to both the chat-path registry (via name) and the
  arikernel ExecutorRegistry view (via toolClass).
- grep for `new ToolRegistry`, `new ExecutorRegistry` outside the
  unified registry module → zero hits.

Branch protocol (REQUIRED):
- First action this session: git checkout -b dry-repair/2C.1 (off main).
- Do ALL work on that branch.
- Last action: ONE git commit on that branch with the message below.
- Do NOT push. Do NOT merge to main. Do NOT commit to main.

Commit message: "refactor(tools): unify registries into src/tools/registry.ts (closes F2)"

Report to: docs/dry-repair-reports/2C.1.md
```

---

## TASK 2C.2 — Unify policy into one evaluator with rule packs

**Wait for: 2C.1 merged.**

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Prereq: 2C.1 merged (src/tools/registry.ts exists as canonical).

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F4
- DRY-REPAIR-PLAN.md → Phase 2C.2
- src/tool-policy/default-rules.ts (DEFAULT_POLICY)
- src/security/layer-core.ts (SecurityLayer checks)
- packages/arikernel/policy-engine/src/engine.ts + defaults.ts
- src/threat/tool-chain.ts (threat-engine checks)
- src/tools/pre-dispatch.ts (assertToolCallAllowed from task 1C —
  this is the call site that consumes the evaluator)

Task: Close F4 — four policy layers (src/tool-policy, src/security,
src/threat, arikernel/policy-engine) each evaluate independently with
no cross-awareness. Unify into one evaluator with pluggable rule packs.

What to do (verbatim from plan §2C.2):

1. Create src/tool-policy/evaluator.ts:
   - One Zod schema for rule shape: {id, kind, match, allow|deny, reason}
   - evaluate(call, packs): {allowed, deniedBy?: RulePack, reason?: string}
   - Rule packs: a sealed list of {id, rules, priority}

2. Refactor existing rule sets into packs:
   - defaultPolicyPack ← src/tool-policy/default-rules.ts
   - securityLayerPack ← src/security/layer-core.ts (file/shell/network checks)
   - threatEnginePack ← extract pre-tool-call checks from src/threat/tool-chain.ts
     (keep post-tool-call analysis in tool-chain.ts — that's a different concern)
   - arikernelPack ← packages/arikernel/policy-engine/src/defaults.ts

3. Update src/tools/pre-dispatch.ts (the function 1C created):
   - assertToolCallAllowed now calls evaluator.evaluate(call, [
       securityLayerPack, defaultPolicyPack, threatEnginePack, arikernelPack
     ]) ONCE instead of chaining four independent checks.
   - Then it still calls approvalManager.gate as the final step
     (approval is per-user, not a rule pack).

CRITICAL: Same RULES, new dispatch mechanism. This is a refactor, not a
policy rewrite. If you find a real bug in a policy rule, flag it —
don't fix it as part of this task.

Constraints:
- The two `defaults` files (src/tool-policy and arikernel/policy-engine)
  must merge cleanly. If they conflict on a rule, take the STRICTER one
  and flag the conflict in your report.
- Don't lose the per-call audit trail — every deny should still produce
  a structured log entry naming the pack and rule.

Acceptance check:
- All existing pre-dispatch tests pass.
- New test: a tool call that is blocked by exactly one pack returns
  a decision naming that pack.
- grep for direct calls to `securityLayer.evaluate`, `toolPolicy.evaluate`,
  `threatEngine.preCheck`, `policyEngine.evaluate` outside the evaluator
  and the rule-pack files → zero hits.

Branch protocol (REQUIRED):
- First action this session: git checkout -b dry-repair/2C.2 (off main, or off the merged 2C.1 commit).
- Do ALL work on that branch.
- Last action: ONE git commit on that branch with the message below.
- Do NOT push. Do NOT merge to main. Do NOT commit to main.

Commit message: "refactor(policy): unify into evaluator with rule packs (closes F4)"

Report to: docs/dry-repair-reports/2C.2.md
```

---

## TASK 2C.3 — Collapse the dispatcher

**Wait for: 2C.2 merged. This is the heaviest task in the plan — soak in a branch for a day before merging.**

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Prereq: 2C.1 (registry) AND 2C.2 (evaluator) merged.

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F2 (the dispatcher half)
- DRY-REPAIR-PLAN.md → Phase 2C.3 (last sub-commit)
- src/tool-executor.ts (chat-path dispatcher, executeSingleTool L197–703)
- packages/arikernel/tool-executors/src/base.ts + file.ts, shell.ts,
  http.ts, database.ts (the AriKernel implementations)
- src/tools/registry.ts (the unified registry from 2C.1)

Task: Close F2 part 2 — two dispatchers (chat-path executeSingleTool and
AriKernel ToolExecutor) become one. AriKernel-specific tool handlers
(file/http/shell/database) get registered as regular tools in the unified
registry and dispatched through the unified dispatcher.

What to do (verbatim from plan §2C.3):

1. Make executeSingleTool the single dispatcher. Input: ToolCall.
   Output: ToolResult. Both shapes already exist; reconcile if needed.

2. Convert each AriKernel executor (file, http, shell, database) to a
   ToolDefinition registered in the unified registry. Their .execute()
   methods become the handler. Capability tokens / taint labels become
   FIELDS on the ToolResult envelope, not a separate execution stack.

3. Delete packages/arikernel/tool-executors/src/base.ts's separate
   execution path. The ToolExecutor class either disappears or becomes
   a thin shim that calls back into executeSingleTool.

4. Anywhere code paths previously routed through ExecutorRegistry to
   execute a tool, redirect to executeSingleTool. ExecutorRegistry-as-view
   (from 2C.1) still works for FILTERING, but no longer for execution.

CRITICAL: This is the highest-risk task in the plan. Land it in a branch
and let Peter soak it for a day before merging.

Be especially careful with:
- File-path policy semantics (AriKernel had strong path-tainting; make
  sure it survives the migration to the unified dispatcher)
- Shell sandboxing rules — same concern
- Any caller that depends on AriKernel-specific error shapes

Constraints:
- No new behavior. Same tools, same safety properties.
- The approval gate runs once per dispatch (via 1C's
  assertToolCallAllowed). If you find yourself adding a SECOND gate
  call, you're doing it wrong.

Acceptance check:
- All tool-execution tests pass — chat-path AND AriKernel-path coverage.
- grep for `ExecutorRegistry.get(`, `executeViaArikernel`, or similar
  parallel-dispatch symbols → zero hits.
- A new tool definition (one file) is callable from both contexts that
  previously needed two definitions.
- Soak: 24h on Peter's machine, watching agent logs for unexpected
  blocks or behavioral surprises.

Branch protocol (REQUIRED):
- First action this session: git checkout -b dry-repair/2C.3 (off main, or off the merged 2C.2 commit).
- Do ALL work on that branch.
- Last action: ONE git commit on that branch with the message below.
- Do NOT push. Do NOT merge to main. Do NOT commit to main.

Commit message: "refactor(tools): collapse to single dispatcher (closes F2 final)"

Report to: docs/dry-repair-reports/2C.3.md
```

---

## TASK 3A — `src/providers/registry.ts` (transport-discriminated)

**Wait for: 1A merged.**

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Prereq verified: PROVIDER_IDS from task 1A is merged
(grep src/providers/provider-ids.ts — must exist).

Read first:
- CLAUDE.md (and project memory: Anthropic OAuth must route through the
  Claude CLI subprocess — direct HTTP fails for Sonnet/Opus on the Max
  plan. This is NOT drift. The registry must accommodate it as a
  first-class transport variant.)
- AGENTS.md
- DRY-AUDIT.md → Findings F8 and F10
- DRY-REPAIR-PLAN.md → Phase 3A (READ THE ANTHROPIC NOTE)
- src/agent-request/resolve-provider.ts
- src/routes/settings/providers.ts
- src/canonical-loop/adapters/openai-compat.ts (the L548 baseURL if-chain)
- src/providers/adapters/openai-http.ts (the L21 reasoning regex)
- public/js/apps.js and public/app.html (UI dropdown — may be optional
  for this task; see below)

Task: Close F8 + F10 — provider metadata scattered across 5+ files.
Adding cerebras yesterday required touching 5 places. Consolidate into
one provider-registry module with a transport-discriminated shape.

What to do (verbatim from plan §3A):

1. Create src/providers/registry.ts. Shape (discriminated union on
   `transport`):

     type ProviderMetaHttp = {
       transport: "http";
       id: ProviderId;
       label: string;
       models: string[];
       defaultModel: string;
       baseURL: string;
       envKey: string;
       capabilities: { reasoning: boolean; tools: boolean; streaming: boolean; ... };
     };
     type ProviderMetaCli = {
       transport: "cli";
       id: "anthropic";
       label: string;
       models: string[];
       defaultModel: string;
       cliBinary: string;   // e.g. "claude" or path
       capabilities: { reasoning: boolean; tools: boolean; streaming: boolean; ... };
     };
     type ProviderMeta = ProviderMetaHttp | ProviderMetaCli;

     export const PROVIDERS: Record<ProviderId, ProviderMeta> = { ... };

   Anthropic's entry has `transport: "cli"`, NO baseURL, NO envKey.
   Every other provider has `transport: "http"`.

   Move the reasoning-capable regex from openai-http.ts:21 into the
   relevant providers' `capabilities.reasoning = true`.

2. Update src/agent-request/resolve-provider.ts:
   - defaultModelFor(id) reads PROVIDERS[id].defaultModel
   - hasCredsFor(id) discriminates: for http, check envKey; for cli,
     check whether the CLI binary is callable (or trust the existing
     CLI auth detection logic).

3. Update src/routes/settings/providers.ts: derive the provider list,
   DEFAULT_MODEL, and UI labels from PROVIDERS.

4. Update src/canonical-loop/adapters/openai-compat.ts:548 — replace
   the `if (provider === "cerebras")` chain with
   `PROVIDERS[provider].transport === "http" ? PROVIDERS[provider].baseURL : <unreachable>`.
   The transport check is also the safety belt that prevents Anthropic
   from accidentally being routed through openai-compat.

5. public/js/apps.js + public/app.html — OPTION A: add a tiny endpoint
   that returns the provider registry as JSON, fetch on UI load.
   OPTION B: if A is heavier than it sounds, leave the HTML alone and
   flag it in the report — UI consolidation can wait for a UI rebuild.
   PICK A IF IT'S UNDER 30 LOC; otherwise B + flag.

CRITICAL: Do NOT try to unify Anthropic into the HTTP family. The
transport discriminator exists precisely to PREVENT that. If you find
yourself special-casing anthropic with `if`s elsewhere, that's the
signal that the discriminator isn't being read.

Constraints:
- Adding a new provider (e.g., "groq") should require editing only
  registry.ts. After this task, that must be true for the BACKEND;
  UI may still need an update if you chose option B above.
- Don't change provider behavior. You're consolidating metadata.

Acceptance check:
- npm run typecheck passes.
- Adversarial: add a fake "test-provider" entry to PROVIDERS with
  transport: "http". Verify resolve-provider, settings/providers, and
  openai-compat all pick it up automatically. Remove after.
- grep for `if (provider === "cerebras"`, `if (provider === "openai"`
  etc. style switches → zero hits outside registry.ts.
- The TypeScript discriminated union prevents code from accessing
  `PROVIDERS["anthropic"].baseURL` without a transport check.

Branch protocol (REQUIRED):
- First action this session: git checkout -b dry-repair/3A (off main).
- Do ALL work on that branch.
- Last action: ONE git commit on that branch with the message below.
- Do NOT push. Do NOT merge to main. Do NOT commit to main.

Commit message: "refactor(providers): transport-discriminated registry (closes F8, F10)"

Report to: docs/dry-repair-reports/3A.md
```

---

## TASK 3B.2 — Delete inline voice orchestration

**Wait for: 3B.1 merged AND Peter signs off on soak (no latency regression).**

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Prereq: 3B.1 merged + Peter has confirmed soak passed (warm-path latency
within ~0.9–3s on his 3060). Do NOT start without that sign-off.

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F9
- DRY-REPAIR-PLAN.md → Phase 3B (stage 2)
- src/voice/voice-session.ts (L204–640 inline clause-chunker/preroll/playback)
- src/voice/gpu-session.ts (L20–210 same, more aggressive flush)
- integrations/open-voice/bridge.ts (the canonical adapter — now default)
- C:\Users\manri\open-voice\lib\ (the actual modules; read clause-chunker,
  preroll-buffer, playback-tracker)

Task: With LAX_VOICE_OPEN=1 now default and soak clean, delete the inline
clause-chunker / preroll buffer / playback-end estimator code from
voice-session.ts and gpu-session.ts. They become thin dispatchers like
realtime-session.ts already is.

What to do:

1. In voice-session.ts: delete the SENTENCE_TERMINATOR regex,
   flushCompletedSentences, expectedPlaybackEndMs timer, PLAYBACK_TAIL_MS
   constant — anything that exists as a module in open-voice/lib.
   Replace with calls into the open-voice bridge.

2. In gpu-session.ts: same — including the more aggressive CLAUSE_BREAK
   regex and CLAUSE_MIN_CHARS threshold. If the early-flush behavior
   isn't already in open-voice, FLAG IT and stop. Peter will decide
   whether to port it upstream first.

3. After deletion, voice-session.ts should be ≤300 LOC and gpu-session.ts
   should shrink proportionally.

4. KEEP the LAX_VOICE_OPEN=0 env escape hatch — it now routes to a
   stub that throws a clear "legacy in-tree path has been removed —
   set LAX_VOICE_OPEN=1 (default) or restore from git." If this feels
   too aggressive, leave the escape hatch as a no-op flag and document
   that the legacy path is gone.

CRITICAL: This is permanent code deletion. The escape hatch from 3B.1
no longer has a working legacy path to fall back to. Make sure Peter
explicitly confirmed soak before you run this.

Constraints:
- Don't touch realtime-session.ts. It's already thin.
- Don't touch open-voice/lib itself.

Acceptance check:
- grep `SENTENCE_TERMINATOR`, `CLAUSE_BREAK`, `flushCompletedSentences`,
  `PLAYBACK_TAIL_MS`, `expectedPlaybackEndMs` in src/voice/ → zero hits
  outside type imports.
- voice-session.ts ≤300 LOC.
- gpu-session.ts substantially smaller than before.
- Manual voice session still works end to end.

Branch protocol (REQUIRED):
- First action this session: git checkout -b dry-repair/3B.2 (off main, after Peter confirms 3B.1 soak passed).
- Do ALL work on that branch.
- Last action: ONE git commit on that branch with the message below.
- Do NOT push. Do NOT merge to main. Do NOT commit to main.

Commit message: "refactor(voice): delete inline orchestration; open-voice is canonical (closes F9 final)"

Report to: docs/dry-repair-reports/3B.2.md
```

---

## TASK 4B — Split SECURITY.md and THREAT-MODEL.md

**Wait for: 1D merged (real contact email already in SECURITY.md).**

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Prereq: 1D merged (SECURITY.md no longer has [TBD]).

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F12
- DRY-REPAIR-PLAN.md → Phase 4B
- SECURITY.md, THREAT-MODEL.md (both)

Task: Close F12 — SECURITY.md and THREAT-MODEL.md overlap on defense
architecture and trust model. Same timestamps, parallel-drafted, layer
numbering already differs. Split cleanly.

What to do (verbatim from plan §4B):

1. SECURITY.md → user-facing only:
   - Reporting procedure (who to contact, what to include)
   - SLA (acknowledgment time, fix time for criticals)
   - Contact: petermanrique101@gmail.com (already set in 1D)
   - Link to THREAT-MODEL.md for "what threats this project actually
     considers"
   - No layer-architecture detail (move it to THREAT-MODEL.md or to
     the shared defense-layers doc below)

2. THREAT-MODEL.md → design-internal only:
   - Trust model (single-user, loopback, no multi-tenant)
   - Threat actors (the 4 classes from current THREAT-MODEL)
   - Attack surfaces
   - Defense-layer architecture (single canonical numbering — pick one,
     not two)

3. Optional: extract a docs/security/defense-layers.md if the layer
   section ends up being referenced from 3+ places. Otherwise leave
   the canonical statement in THREAT-MODEL.md and link from SECURITY.md.

Constraints:
- This is a content split, not a rewrite. Preserve the underlying claims;
  reorganize them.
- No new claims. If you notice a real gap (e.g., a layer not actually
  implemented in code), flag it in the report — don't quietly fix it
  by deleting.

Acceptance check:
- Layer numbering appears in EXACTLY ONE place.
- SECURITY.md is reading-time ≤2 minutes (it's a user-facing doc).
- A reader following the links from SECURITY.md → THREAT-MODEL.md
  doesn't re-encounter the same content.

Branch protocol (REQUIRED):
- First action this session: git checkout -b dry-repair/4B (off main).
- Do ALL work on that branch.
- Last action: ONE git commit on that branch with the message below.
- Do NOT push. Do NOT merge to main. Do NOT commit to main.

Commit message: "docs(security): split SECURITY (user-facing) from THREAT-MODEL (design) (closes F12)"

Report to: docs/dry-repair-reports/4B.md
```

---

## TASK 4C — README full + shared install core

**Wait for: 1D merged (README stub exists).**

```
You are completing one task in a coordinated multi-session DRY repair effort.
Working dir: c:\Users\manri\local-agent-x

Prereq: 1D merged (README.md stub exists at root).

Read first:
- CLAUDE.md
- AGENTS.md
- DRY-AUDIT.md → Finding F15
- DRY-REPAIR-PLAN.md → Phase 4C
- README.md (stub from 1D)
- install.bat, install.ps1, install.sh, start.bat, desktop-launch.bat

Task: Close F15 main — expand the README stub and consolidate the three
install scripts' actual logic into one shared core that the OS wrappers
invoke.

What to do (verbatim from plan §4C):

1. Expand README.md:
   - Project description (2–3 paragraphs)
   - Prerequisites (Node version, OS notes)
   - Install commands by OS (one line each)
   - Quick-start: run the app, sign in, where the UI lives
   - Dev commands (typecheck, test, lint if applicable)
   - Architecture overview: one paragraph + link to AGENTS.md +
     link to docs/audits/2026-05-canonical-refactor/INDEX.md
     (this dir was created by task 4A)
   - Status section linking to AUDIT-STATE.md and DRY-REPAIR-PLAN.md

2. Create scripts/install-common.mjs containing the ACTUAL install
   logic: Node version check, npm install, voice-models fetch if
   applicable, env file scaffold, sanity checks.

3. Update install.bat, install.ps1, install.sh to be thin wrappers:
   each handles only the OS-specific bootstrap (verifying Node is
   on PATH, choosing the right shell, etc.) then calls
   `node scripts/install-common.mjs`.

Constraints:
- Don't add features to install logic. Audit what's currently in the
  three scripts and consolidate the COMMON logic. OS-specific bits
  stay in the wrappers.
- If the three scripts currently DO DIFFERENT THINGS (not just
  different syntax for the same thing), flag that in the report —
  Peter needs to decide what the right behavior is, not you.

Acceptance check:
- README is reading-time ≤5 minutes, ≤300 LOC.
- A new contributor can install on their OS from the README alone.
- scripts/install-common.mjs is the single source for install steps;
  the three OS wrappers are each ≤30 LOC.
- Changing an install step requires editing one file.

Branch protocol (REQUIRED):
- First action this session: git checkout -b dry-repair/4C (off main).
- Do ALL work on that branch.
- Last action: ONE git commit on that branch with the message below.
- Do NOT push. Do NOT merge to main. Do NOT commit to main.

Commit message: "docs+scripts: full README + shared install core (closes F15)"

Report to: docs/dry-repair-reports/4C.md
```

---

# How to hand back

When a session finishes:
1. Session writes its report to `docs/dry-repair-reports/<task-id>.md`.
2. Session does NOT push.
3. Peter reviews the diff + report; merges into main (or branch) at his cadence.
4. Peter pastes (or shares the path of) the report back to the orchestrator session — that's me.
5. Orchestrator updates its todo list, decides what becomes safe to dispatch next, hands the next prompt.

If a session reports `blocked` or surfaces a surprise that affects another task's prompt, the orchestrator session adjusts and re-emits the affected prompt before Peter dispatches it.
