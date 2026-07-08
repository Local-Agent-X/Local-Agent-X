# Harness Mechanisms Backlog

Clean-room spec for ~40 harness mechanisms to adopt in LAX. Each entry describes
BEHAVIOR and RATIONALE only — implementers design the code fresh against LAX's own
architecture. This document is the sole brief for implementation work; no other
reference material exists or should be sought. All thresholds/constants below are
starting suggestions — tune against our own telemetry (completion ledger,
token-estimation, cost-tracker) where possible.

Tiers: **T1** = hits a known LAX weakness, do first. **T2** = high leverage.
**T3** = small, cheap wins. Sizing: S (&lt;half day), M (1–2 days), L (multi-day).

---

## A. Prompt-cache discipline (cross-cutting; do A1 before anything that forks)

### A1. Cache-riding forked side-agents ("perfect fork") — T1, L
Any background LLM job that needs conversation context (summarizers, memory
extractors, status-line generators, side questions) must be launched as a fork that
reuses the parent request's exact cache-key components: same system prompt string,
same tool list, same thinking/effort config, same message prefix. Behavior is
constrained exclusively through a tool-permission callback that denies at call time —
never by removing tools from the list, never by overriding max-output-tokens or
effort, because every one of those is part of the provider cache key and turns the
fork into a full-price cache miss.
- Snapshot the "last cache-safe params" (system prompt, contexts, message prefix)
  at end of each main-loop turn so post-turn forks need no plumbing.
- Support a `skipCacheWrite` flag for fire-and-forget forks whose prefix will never
  be read again.
- Lands: `src/canonical-loop/` + `src/agent-request/prepare-request.ts`; a shared
  `forked-agent` helper all background services must use.
- Applies to direct-API adapters and any caching provider. The Anthropic CLI-proxy
  lane can't express this; scope to lanes that can and document the gap.

### A2. Cache-break detection subsystem — T2, M
Per conversation lane, hash every cache-key component separately on each request:
system prompt (with and without cache markers), each tool's schema individually,
beta/header set, model, effort, extra body. When observed cache-read tokens drop
more than ~2k versus the prior request, diff component hashes and log WHICH
component changed (e.g. "tool X description changed"). Legitimate breaks
(compaction, deliberate context edits) pre-announce themselves to the detector so
they are not flagged. Bound memory (track ~10 lanes max). Write a diff artifact for
debugging.
- Lands: new `src/context-manager/cache-break-detection.ts`, fed from adapters;
  surfaced in telemetry.

### A3. Delta attachments for volatile lists — T2, M
Never embed dynamic lists (available agents/templates, deferred tools, connector
instructions) in tool descriptions or the system prompt — any change busts the
whole schema cache. Inject them as delta messages in the conversation stream: on
each turn, reconstruct the "already announced" set by replaying prior delta
attachments in the transcript, and emit only adds/removals. Compaction removing old
deltas naturally triggers a full re-announce (re-announce against empty history
after compact).
- Lands: `src/context/builder.ts` + wherever agent/tool lists are currently
  serialized into prompts.

### A4. Never mutate API-bound messages — T2, S
Any enrichment of tool inputs/outputs for observers (hooks, UI, transcript,
telemetry) is applied to clones; the original objects flow byte-identical into the
next request. Audit current loop for in-place mutation of history objects.
- Lands: `src/canonical-loop/turn-loop.ts`, `src/tool-execution/`.

---

## B. Compaction & context pipeline

### B1. Layered compaction pipeline — T1, L
Replace single-stage compaction with an ordered per-turn pipeline, cheapest first,
where each stage re-checks whether enough space was freed before the next runs:
1. model-driven pruning (see B6), 2. tool-result microcompaction (B5),
3. full summarizing compaction, 4. hard blocking-limit preempt. Threshold
arithmetic must reserve explicit buffers: context window minus max-output minus a
summary-output reserve minus a safety buffer; derive warning and manual-compact
thresholds from the same effective window so all limits stay consistent.
- Lands: `src/context-manager/` (compaction.ts, overflow-detection.ts) driven from
  `src/canonical-loop/turn-loop/compact-history.ts`.

### B2. Compaction circuit breaker — T1, S
After 3 consecutive failed compaction attempts in a session, stop attempting for
the rest of the session and surface a clear error state. Reset the counter on any
success. Prevents doomed retry loops from burning API calls when context is
irrecoverably over the limit.
- Lands: `compact-history.ts` loop state.

### B3. Summarizer-request overflow retry by dropping whole rounds — T2, M
If the summarization request itself overflows, group history into API-round groups
(boundary = new assistant message id) and drop oldest whole groups until the
reported token gap is covered (fall back to dropping ~20% when the gap is
unparseable); max 3 retries; prepend a synthetic user marker if the surviving slice
starts with an assistant message. Never cut inside a round — orphan tool_results
and split thinking blocks poison the next request.
- Lands: `src/context-manager/compaction.ts`.

### B4. Post-compact working-set restoration — T1, M
After compaction, restore the agent's working set under explicit budgets: re-read
the ~5 most-recently-read files fresh from disk (cap per-file and total tokens),
re-inject the active plan/task file, and re-inject the status of still-running
subagents/ops so the model doesn't respawn duplicates. Skip files whose content is
already visible in the preserved message tail. Fixed deterministic reconstruction
order: boundary marker → summary → kept tail → restored attachments.
- Lands: `src/context-manager/` + `src/ops/` (running-op status source).

### B5. Tool-result microcompaction — T2, M
Before full compaction is needed, clear the content of old compactable tool results
(reads, shell output, searches) beyond the last N (~5), replacing each with a short
stub telling the model it can re-run the tool if needed. Two triggers: (a) token
pressure; (b) time-based — if the gap since the last assistant message exceeds the
provider cache TTL (~1h), the prefix rewrite is free anyway, so clear aggressively
before the request. Where the provider supports server-side context editing, prefer
that API over local mutation.
- Lands: `src/context-manager/`; provider capability flag in adapters.

### B6. Model-driven history pruning ("snip") — T3, M
Give the model a tool to discard its own stale history ranges. Bookkeeping trap:
freed tokens are invisible to usage-anchored counting (the surviving tail's usage
still reflects pre-prune context), so track cumulative pruned tokens and subtract
them in every threshold check. Nudge the model to prune after every ~10k tokens of
growth without one.
- Lands: new tool in `src/tools/` + `src/tool-policy/` row + counting fix in
  token estimation. Follow the tool-registration checklist.

### B7. Session-notes compaction bypass — T1, L (depends A1, D1)
When a continuously-maintained session-notes file exists (D1), attempt compaction
by substituting the notes file for the LLM summary: keep a raw-message tail
computed backwards from the last-summarized marker to meet minimum token/text
quotas, and abort to the normal summarizer if the result would still exceed the
threshold. Cut points must preserve API invariants: every kept tool_result keeps
its tool_use; records sharing one streamed message id stay together.
- Lands: `src/context-manager/` new module.

### B8. Post-compact state cleanup — T2, S
One function clears every module-level cache invalidated by compaction (memoized
user context, classifier approvals, dedup sets, microcompact state), scoped so
subagent compactions don't wipe main-thread state. Anything reconstructed by
replaying the transcript (A3 deltas, budget counters) self-heals and needs no
cleanup — prefer that design.
- Lands: `src/context-manager/`.

### B9. Withhold recoverable stream errors — T2, M
When a stream fails with prompt-too-long / max-output / oversized-media, don't
surface the error immediately: keep it, attempt recovery (reactive compact,
truncation retry), and only show the error if recovery fails. The user sees a
seamless turn instead of a crash-then-manual-retry.
- Lands: `src/canonical-loop/turn-loop.ts` error path.

---

## C. Context accounting & injection

### C1. Anchor-plus-estimate token counting — T1, M
Canonical context size = last response's real usage (input + cache-read +
cache-creation + output) + estimated tokens of messages appended since. Walk back
to the FIRST record of a multi-record assistant turn (parallel tool calls share one
message id with interleaved tool_results) before slicing, or appended results get
undercounted. Exclude synthetic/meta messages from the anchor search.
- Lands: `src/context-manager/token-estimation.ts` (replace pure estimation).

### C2. File-type-aware token ratios — T3, S
Rough estimation: ~chars/4 for prose/code, ~chars/2 for JSON-dense content; pad
message-level estimates ~4/3 when used for safety decisions so oversized results
don't slip through on an underestimate.
- Lands: `token-estimation.ts`.

### C3. Turn-counted reminder throttling — T2, S
Pace recurring system reminders by counting HUMAN turns since last injection, read
from the transcript (filter out tool_result user messages — otherwise "10 turns"
means "10 tool calls"). Compaction removing old reminders naturally re-opens the
budget because the counter is transcript-derived, not stored.
- Lands: `src/context/builder.ts` / inject-queue.

### C4. Budgeted memory surfacing — T2, S
Cap relevance-surfaced memory content per file (lines AND bytes), per turn (count
and bytes), and per session (cumulative bytes), with the session counter computed
by scanning the transcript so compaction re-opens it.
- Lands: `src/associative-recall/` injection path.

### C5. Context introspection command — T3, M
A user-facing breakdown of the live window: system prompt sections, memory,
per-tool definitions (subtract the per-request tool-preamble overhead so N tools
don't each show the fixed cost), skills/connectors, messages, and explicit
"reserved for compaction" categories.
- Lands: new slash command + `src/context-manager/status.ts`.

### C6. Attachment assembly with a hard timeout — T3, S
All per-turn reminder/attachment getters run in parallel tiers under a ~1s abort so
reminder computation can never stall prompt submission; sample timings for
telemetry.
- Lands: `src/context/builder.ts`.

### C7. Compaction-awareness reminder — T3, S
Past a usage fraction, tell the model compaction is coming so it can externalize
state (write notes/plan) before memory loss. Optionally expose used/remaining
tokens as an attachment.
- Lands: `src/context/builder.ts`.

---

## D. Memory & background services

### D1. Continuous session-notes file — T1, L (depends A1)
Per-session markdown notes maintained by a cache-riding fork that is permitted
exactly one operation: editing that one file. Fixed section template (title /
current state / task spec / files / workflow / errors & corrections / learnings /
results / worklog); the fork edits content under headers, never headers. Dual
trigger: context growth threshold + minimum tool calls since last run, or threshold
+ natural break (assistant turn with no tool calls); require a minimum context size
before first run. Self-limiting: parse per-section sizes before each update and
append condense directives for oversized sections; hard-truncate per section when
injected elsewhere. Serialize runs; compaction waits briefly for an in-flight
update and treats a stale one as crashed.
- Feeds B7 (compaction bypass) and D4 (away summary).
- Lands: new `src/session/session-notes.ts` + background service registration.

### D2. End-of-turn memory extraction, coalesced — T2, M (depends A1)
Extraction fork fires at end of complete turns. State: cursor id of last processed
message; an in-progress flag; a stash-one-trailing-run coalescer (a request arriving
mid-run overwrites the pending slot; exactly one trailing run processes the delta).
Mutual exclusion with the main agent: if the main agent already wrote to a memory
path since the cursor, skip and advance. Jail the fork: reads unrestricted,
shell only if read-only, writes only inside the memory dir. Pre-inject the
memory-dir manifest (filenames + descriptions + ages) so the fork doesn't burn a
turn listing; batch reads turn 1, writes turn 2; hard max-turns ~5; cursor advances
only on success; drain pending extraction before process shutdown.
- Lands: extend `src/memory/auto-extract.ts` / `end-of-turn-write.ts`.

### D3. Consolidation lock as mtime — T3, S
One lock file: mtime IS the last-consolidated timestamp, body is holder PID.
Read last-run = one stat. Acquire = write PID then read back to verify the win;
stale if mtime recent with dead PID; rollback on failure = rewind mtime and clear
body. Gates ordered cheapest first: time stat → throttled session-count scan →
lock.
- Lands: `src/memory/consolidation-pipeline.ts` / dream scheduling.

### D4. "While you were away" summary — T3, S (depends A1, D1)
On return from idle, send the last ~30 messages + session-notes file to a fast
model for 1–3 sentences: the high-level task, then the concrete next step; skip
status narration. Mark the request skip-cache-write.
- Lands: `src/session/` + chat UI surface.

### D5. Memory staleness framing — T3, S
When surfacing memories, convert file age to relative form ("47 days ago") — models
reason about staleness far better from relative age than ISO timestamps. Memories
older than ~a day get a caveat that file/line citations may be outdated.
- Lands: memory injection formatting.

### D6. Recall hygiene filters — T3, S
(a) Track an already-surfaced set per session so the per-turn budget is never spent
re-picking memories shown earlier. (b) Pass recently-used tools as a hint: don't
surface usage docs for tools actively in use, DO surface gotcha/warning memories
about them.
- Lands: `src/associative-recall/`.

### D7. Self-updating docs — T3, M (depends A1)
Any file whose first line carries a magic marker becomes tracked the moment the
agent reads it (sniff read contents). At idle points, fork one agent per tracked
doc allowed only to edit that doc, with an optional per-doc instruction line under
the header. Header removed → untracked. The document opts itself into maintenance.
- Lands: new background service; register in one startup housekeeping entrypoint.

### D8. Background housekeeping discipline — T3, S
Single startup entrypoint wires all background services. Slow ops deferred ~10 min
and re-deferred whenever the user interacted in the last 60s (checked before each
op). Recurring cleanups use marker files + locks so concurrent processes skip. All
timers unref'd so housekeeping never blocks process exit.
- Lands: `src/` startup path; battery-scheduler is a natural home.

### D9. Session search funnel — T3, M
Two-stage session search: cheap substring prefilter across title/branch/summary/
first-prompt/transcript to ≤100 candidates (backfill with recent), then one
fast-model call ranking by explicit priority (tag &gt; title &gt; branch &gt; content &gt;
semantic) with a recall-biased "when in doubt, include" instruction, returning
indices only. Excerpts = head+tail slices, not whole transcripts.
- Lands: `src/session/` + `src/agent-store/`.

---

## E. Tool & permission layer

### E1. Tri-state shell security parse — T1, L
Parse shell commands to a real AST. Three outcomes: **simple** (clean argv list,
quotes resolved, no substitutions → safe to policy-match), **too-complex** (command
substitution, expansions, control flow → always escalate to ask/deny, never
auto-allow), **parser-unavailable** (fall back to existing parser). Iron rule: deny
rules are checked BEFORE any downgrade — "too complex" can never soften a deny into
an ask. Roll out in shadow mode first: run the new parser alongside the old, log
divergence, keep the old verdict authoritative until telemetry is clean.
- Complements the harness-hardening doctrine already adopted: deterministic for
  adversary-controlled input, LLM-confirm for first-party.
- Lands: `src/tools/` bash sink + `src/tool-policy/evaluator.ts`.

### E2. Deterministic obfuscation validators — T1, M (with E1)
Battery of pure-code validators run on every shell command regardless of parse
outcome: IFS injection, process-environ path access, unicode/exotic whitespace,
backslash-escaped operators, brace expansion, mid-word comment chars,
quote/comment desync, quoted newlines, carriage returns, heredoc substitution
checks. Also: iteratively strip safe wrappers and safe env-var prefixes to a fixed
point before matching (`timeout 300 FOO=bar tool run …`), with a hard blocklist of
binary-hijack env vars (PATH, LD_*, DYLD_*, PYTHONPATH, NODE_OPTIONS…) that make a
command unsafe to strip. Re-validate the ORIGINAL command for redirections after
per-segment checks (segment processing strips redirects — closes the
`x | xargs … >> file` bypass).
- Also in scope: the grep tool currently swallows real rg errors as "no matches"
  (rg exit-code conflation — a known parked defect); fix exit-code handling so
  errors surface as errors across every rg call site.
- Lands: same seam as E1.

### E3. Sandbox as auto-allow currency — T1, M
Invert the relationship: sandboxed execution is the default and EARNS auto-approval
— a sandboxed command may skip even an ask rule; unsandboxed execution is the
escape hatch that needs the prompt. Per-subcommand sandbox decisions on compound
commands so one safe segment can't carry the rest. Any "excluded commands"
convenience list is documented as UX, not a security boundary.
- Lands: `src/sandbox/` + `src/tool-policy/evaluator.ts` decision order.

### E4. Permission decision order, bypass-immune floors — T2, M
Fixed evaluation order: deny rule → ask rule → tool's own check → deny wins over
everything → content-specific safety floors that even bypass/auto modes cannot
skip (VCS internals, agent-config dirs, shell rc files) → mode-level allows →
tool-wide allow → explicit passthrough state (no opinion) that becomes ask.
- LAX already has default-deny policy rows; this adds the explicit ordering and
  the bypass-immune floor class.
- Lands: `src/tool-policy/evaluator.ts`.

### E5. Learned-rule suggestion hygiene — T2, M
If/when approvals can persist "don't ask again" rules: never suggest interpreter/
wrapper/shell prefixes (a rule for a shell or env-runner ≈ allow-everything);
multi-line/heredoc commands become prefix rules (exact match would never fire
again); extract two-word command+subcommand prefixes only when leading env vars are
all safe; cap suggested rules per compound command; above a subcommand cap, fall
back to ask. On entering any auto mode, strip existing dangerous allow rules that
would bypass review, and tell the user which were stripped.
- Lands: `src/approval-manager.ts` + policy persistence.

### E6. Per-invocation capability predicates — T2, M
Tool capability checks take the INPUT, not just the tool identity: is-read-only(input),
is-concurrency-safe(input), interrupt-behavior(input). A shell call is read-only
for a listing and destructive for a delete; per-invocation classification drives
parallel scheduling, auto-approval fast paths, and UI collapsing. Build tools
through one constructor that spreads fail-closed defaults (not concurrency-safe,
not read-only, destructive) so a lazy tool author can't accidentally opt in.
- Lands: `src/tools/registry-build.ts` + `Tool` interface.

### E7. Oversized tool-result spill — T2, M
Results over a per-tool byte cap are written to a session results dir; the model
gets a short preview + the file path. File-read tools are exempt (persisting a read
creates a read→file→read loop). Keep an aggregate per-conversation replacement
budget; forks clone the parent's replacement state so cache-sharing forks make
identical decisions.
- Lands: `src/tool-execution/execute-tool.ts` envelope layer.

### E8. Model-actionable validation errors — T3, S
Schema-validation failures return as structured tool errors the model can act on
(no auto-retry loop — the model self-corrects next turn). Add a cause-class hint
when a deferred/unloaded tool was called with stringly-typed params: "schema was
never loaded; search for it, then retry."
- LAX's 5-state envelope already exists; this adds the hint layer.
- Lands: `src/tool-execution/` validation path.

### E9. Read dedup + external-change diffs — T2, M
Track per-file read state (content, mtime, range, partial-view flag) in a bounded
LRU. (a) Re-read of an unchanged file+range returns a one-line "unchanged since
last read" stub. (b) Each turn, mtime-check all tracked files; externally modified
files get a DIFF SNIPPET attachment against the cached content, not a full re-read.
Evict only on file-gone, never on transient stat errors (editor atomic-save races).
Partial views (offset reads, stripped injections) never dedup and require a fresh
read before edits.
- Lands: new `src/context-manager/file-read-state.ts`, wired into read/edit tools
  and turn attachments. Build on the existing `src/language-intel/` per-project
  file/tsconfig mtime-staleness cache — extend that state layer, do not fork a
  parallel one.

### E10. Hook scoping via the permission-rule grammar — T3, M
One rule grammar (`Tool(pattern)`) shared by permission rules AND hook `if`
conditions, with escaped-paren parsing, legacy-name aliases so renamed tools keep
matching persisted rules, and wildcard semantics where a trailing " *" makes args
optional on single-wildcard patterns only. Hooks can rewrite tool inputs, append
context, deny with retry-permission, or auto-respond to elicitations; all hook
execution requires workspace trust.
- Lands: `src/hooks/hook-engine.ts` + `src/tool-policy/` shared matcher.

---

## F. Orchestration & tasks

### F1. Mid-turn worker steering queue — T1, M
Messages sent to a running worker never interrupt it: they land in a per-task
pending queue drained at tool-round boundaries and injected as user messages.
Decouple API input from UI transcript mirroring. (Matches the delegation-guidance
contract already pinned in our prompt tests — this is the runtime to match it.)
- Lands: `src/agency/handler.ts` + worker session loop.

### F2. Coordinator protocol: notifications-as-messages — T2, M
Worker lifecycle events arrive in the supervisor's conversation as user-role
messages wrapping structured task-notification blocks (id, status, summary, result,
usage) that the system prompt teaches the model to distinguish from real user
input. Prompt rules that matter: mandatory synthesis (the supervisor restates
concrete specifics itself, never "based on the findings above"); a continue-vs-
spawn-fresh table keyed on context overlap (verifiers ALWAYS fresh so they can't
rubber-stamp); never fabricate worker results.
- Lands: `src/agency/` supervisor prompt + notification plumbing.

### F3. Unified task registry, typed id prefixes — T2, M
Every background unit (shell job, worker, cron run, dream, monitor) is one task
type in a single registry keyed by `prefix + 8 random chars` from a
case-insensitive-safe alphabet (entropy deliberately high enough to resist
guessing output-file paths). Keep the polymorphic surface minimal — kill() only.
- Lands: `src/ops/` consolidation.

### F4. Task output as delta-polled files — T2, M
Worker output files are the worker's own transcript (symlink or same file); pollers
read only byte deltas from a stored offset; status updates ship offset patches, not
full task snapshots (spreading a stale snapshot can zombify a task that completed
during an async read). Open output files no-follow; cap size; drain write queues
from a flat array so chunks GC immediately.
- Lands: `src/ops/` + `src/agency/worktree.ts` output plumbing.

### F5. Foreground→background promotion — T2, M
Long-running foreground shell commands get moved to background mid-flight past a
blocking budget, returning task id + output path and telling the model to poll —
plus an explicit background signal a UI keypress or timer can resolve to detach a
worker from the UI without killing it. Cascade kills parent→children via chained
abort controllers.
- Lands: shell tool + `src/agency/`.

### F6. Live worker status lines — T3, S (depends A1)
Every ~30s, fork the worker's own conversation and ask for a 3–5 word present-tense
action summary, passing the previous one with "say something new". Re-arm the timer
on completion, not initiation, so summaries never overlap. Token display: latest
input tokens (cumulative per turn), summed output tokens.
- Lands: `src/agency/` + chat UI task cards.

### F7. Remote/cron session resume via sidecar metadata — T3, M
Persist spawn identity (session id, task type, metadata) in a per-session sidecar;
never persist status — re-fetch it on resume (gone → drop, auth error → keep as
recoverable, else re-register and restart polling with a fresh poll-start so
timeouts don't fire retroactively). Debounce remote idle: require N consecutive
idle polls with no log growth before believing completion.
- Lands: `src/ops/` durable operations + scheduler run history.

### F8. Turn budget with diminishing-returns stop — T3, S
When a per-turn output budget is set: a natural stop under ~90% of budget injects a
synthetic "keep going" continuation; stop early anyway if 3 consecutive
continuations each produced &lt;500 new tokens. Smarter anti-runaway than pure
nudge-count or wall-clock ceilings — compose with the existing NUDGE_CEILING.
- Lands: `src/agent-loop/inject-queue.ts` / nudge logic.

---

## G. Product touches

### G1. Skills with path-conditional activation — T2, L
Directory-based skill loading (managed &gt; user &gt; project precedence), first-wins
deduped by realpath identity (symlinks can't double-register; inodes unreliable on
some filesystems). Skills declaring path patterns are held out of the prompt
entirely and activate only when a matching file is touched, deeper paths winning.
Prompt cost estimated from frontmatter only; bodies load on invocation. Bundled
skills may embed reference files extracted lazily to disk on first use.
- Lands: grow `src/slash-commands.ts` + `src/plugin-system.ts` into a skills dir
  model.

### G2. Usage insights report — T3, M
Pipeline over local telemetry: per-session facet extraction (LLM over summarized
transcripts) cached as JSON per session id so reruns are incremental →
deterministic aggregation (including concurrent-session detection via sliding
time-window over message timestamps) → parallel per-section LLM narration into a
readable report. The completion ledger + op-outcomes already hold the raw data.
- Lands: new command + `src/tool-usage-telemetry.ts` consumers.

### G3. Voice STT keyword hints — T3, S
Feed the STT engine up to ~50 session-specific vocabulary hints: a fixed technical
lexicon + project name + current git branch, identifiers split by camelCase/kebab/
snake. Promote unreported interim transcripts on stream close so hold-to-talk never
drops the tail.
- Lands: Python voice sidecars (Lite path) + `src/voice/` session context.

### G4. Layered mic-capture fallback with active probing — T3, S
Capture backends tried in order (native → CLI recorders), where "available" means
an actual device-open probe (spawn against null output, alive after ~150ms = device
opened), not a which-check; memoize per session; defer native audio library load to
first use (audio-stack loads can block seconds post-boot).
- Lands: `src/voice/` capture selection.

### G5. Doctor checks context health — T3, S
Extend self-diagnosis beyond install integrity: warn on oversized instruction
files, tool-definition bloat, connector/MCP prompt weight — the things that
silently degrade every turn.
- Lands: existing audit/doctor surface.

### G6. Tips paced by session count — T3, S
Tip cooldowns measured in sessions-elapsed (startup counter at last show), not
wall-clock; never-shown ranks first. LRU selection over relevant tips.
- Lands: chat UI onboarding surface.

### G7. Cost restore keyed by session id — T3, S
Persist per-model usage (input/output/cache-read/cache-write + cost) with the
session id; on resume, restore cost state only if the ids match. Cheap crash-safe
cost continuity, no database. Flag unknown-model pricing explicitly in the display.
- Lands: `src/cost-tracker.ts`.

---

## Dependency notes for campaign planning

- A1 first; D1/B7/D4/F6/D7 depend on it. B1 before B2–B9. C1 before B* threshold
  work. E1 before E2. F3 before F4/F5/F7.
- B1/B9 modify the turn loop, which now also hosts the post-edit-diagnostics
  middleware and diagnostics-aware verify gates (language-intel campaign, already
  on main). Those insertions must compose with — never bypass or reorder — the
  diagnostics/verify steps; run their suites in blast-radius checks.
- Highest-value serial spine: A1 → D1 → B1 → B7. Most of E, C, D3–D9, F, G are
  parallelizable.
- Every chunk: canonical-check (extend the owning module, no forks), blast-radius
  on shared anchors (tool-policy rows, capability sets, context builder), tests
  per the house rule, no file over 400 LOC.
