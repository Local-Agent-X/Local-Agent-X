# Campaign — Autonomous procedural learning loop (skill-review fork)

Status: **APPROVED — EXECUTING** (user said "Go", 2026-07-25)
Started: 2026-07-25
Engine: ledger-driven Agent loop, single working tree (footprints are disjoint,
so worktrees buy nothing and cost merge risk)
Never push.

**Pre-existing uncommitted work:** `desktop/src/browser-chat-overlay.ts`,
`desktop/src/browser-views.ts` are dirty at campaign start and belong to the
browser-view-bounds fix, NOT this campaign. **Every chunk commit must `git add`
explicit paths — never `git commit -a`.**

---

## Goal (one sentence)

Give the agent a post-turn background review fork that reads the conversation it
just had, decides on its own whether a reusable procedure emerged, and writes or
patches a protocol autonomously — and make that protocol automatically surface on
future matching requests so it actually gets used.

## Reference design

Hermes `agent/background_review.py` + `_SKILL_REVIEW_PROMPT` +
`prompt_builder.py` `SKILLS_GUIDANCE` / `<available_skills>` index.
Ported, not copied: LAX seams differ. Two halves, both required —
**author autonomously** (write) and **surface automatically** (read).
The write half without the read half is dead code.

## Done-list (checkable)

1. After a turn that did non-trivial tool work, a background fork runs with a
   restricted tool allowlist and no user-facing streaming.
2. The fork can CREATE a new protocol and PATCH an existing one, autonomously,
   with no user confirmation.
3. Protocols the fork wrote are stamped with agent-authored provenance,
   distinguishable from user-authored ones.
4. On a later matching user message, the protocol is surfaced to the model
   automatically without the user typing a slash command.
5. The memory end-of-turn pass and the new skill pass cannot starve each other
   (proven by a cross-seam test).
6. Agent-authored protocols are listable and archivable (recoverable delete).
7. Full `npm run build` green; existing suite green; per-seam tests added.

## Out of scope (explicit)

- Deleting or refactoring the C1-C12 cross-session-learning campaign
  (src/cognition/cross-session-learning/, src/protocols/learned-*). It stays as
  is. Reuse only where it is already the canonical (the Memory-tab card).
- Any user-facing approval/consent gate on protocol writes. Decided:
  AUTONOMOUS. (User reaffirmed after the risk was stated.)
- Pushing. Committing per chunk only.
- Mobile / broker surfaces.
- Rewriting the protocol tool's action surface.
- Hand-writing the Thriveventory PO protocol (that is a post-campaign test of
  the loop, not a chunk).

## Decisions locked

| # | Decision | Rationale |
|---|---|---|
| D1 | Autonomous writes, no click gate | User directive, reaffirmed after risk stated |
| D2 | ~~Gate follows authoring session~~ | superseded by D1 — no gate at all |
| D3 | Own coalescer state keyed sessionId+kind | shared single pending slot would starve one pass |
| D4 | Trigger = tool-iteration count, not hasCurateSignal | curate signal is memory-worthiness, wrong axis |
| D5 | Write via builder.ts, never custom.json directly | canonical-check verdict EXTEND |
| D6 | ~~Spawn via agents/invoke.ts capTools~~ | **REVERSED — see D6-REV** |
| D7 | Provenance stamp + archive/unarchive = the safety story | replaces the consent gate; Hermes pattern |
| D8 | Provenance is an ADDITIVE field on `ProtocolSource`, NOT a 5th `type` variant | `type` is a 4-value discriminator read by UI affordances, dedupe, the 403 checks at `routes/bridges/protocols.ts:83-85,130-132`, and `learned-suggestion.ts:65`. Adding a variant is high blast-radius on a shared anchor for zero benefit. Agent-authored protocols ARE custom — that's correct and makes them archivable (archive only works on custom.json, `archive.ts:69-90`). Add `authoredBy?: "agent"\|"user"` + `authoredAt?` + `authoredFromSession?`. |
| D9 | Fork writes through a builder path that dedups AND accepts `body` | F3 tension. Extend the create path rather than pick one. |
| D10 | F1/F2/F4 are IN SCOPE as their own chunk | F1 makes the read half fail silently; F2 makes the write half lose data under exactly the concurrency this campaign introduces. Not drive-by refactors — the campaign is incorrect without them. |
| D6-REV | **Supersedes D6.** Fork runs as a background job via `runAgentViaCanonical`, NOT `invoke.ts`. Register in `src/server/background-jobs/`, modeled on `dream-check.ts`. | invoke.ts broadcasts `handler:agent-spawn`/token-deltas/`agent-complete` unconditionally and silently discards `opts.toolOverride` when templateId resolves. Earlier verdict came from grepping `capTools` without tracing the driver. |
| D11 | Fork prompt + tool list must be STATIC (no per-run briefing/parentContext) | only way to share the 5-min provider prefix cache across forks; also shrinks injection surface |
| D12 | Tool list must exclude every agent-spawn tool | no depth cap exists in the codebase; the allowlist is the only recursion guard |
| D13 | Trigger lives in `turn-loop/record-outcome.ts` as a sibling of `recordCommittedLearningOutcome`, reusing `collectToolSequence` | that file already owns "op terminal + full tool sequence + should we learn". A second seam elsewhere would fork it. |
| D14 | Sibling does NOT apply `isLearningOutcomeEligible` | D1 requires learning from browser sessions; that gate exists for durable MEMORY promotion, a different axis |
| D15 | Wire F5's `long-task-completed` boost from the same site | dead slot built for this exact signal; leaving it dead while adding a parallel counter would be the duplication this repo keeps paying for |
| D16 | Retrieval = EXTEND `learned-suggestion.ts` scoring to cover agent-authored custom protocols + move the nudge to the unfenced `harnessNotice()` channel. **NOT** a new always-present catalog index. | `scoreProtocol`/MIN_SCORE already exist and already run every turn (`build-context.ts:113`). Reuses the canonical, adds ~1 line of tokens instead of a whole catalog, and avoids a high-risk new section in `system-prompt-builder.ts`. A full Hermes-style index is the fallback if scoring proves too narrow. |
| D17 | Fork runs under the existing `foregroundIdle` gate (`background-jobs/index.ts:78-129`) | follows the established background-job pattern; background lane is already 1-concurrent |
| D18 | **Chunk A fixes tool NAMES only — it must NOT broaden the foreground save trigger.** `:236` keeps its original "hard-won service-specific workflows" scope. | Chunk A's first pass also rewrote the trigger to "any non-trivial multi-step workflow" and turned a *proposal* into an unconditional write. Caught by the skeptic. Broadening the foreground rule creates a SECOND autonomous authoring path that races and double-authors against chunk D's fork — the exact duplication this repo keeps paying for. One responsibility, one owner: narrow service-specific authoring in the foreground, general "this turn produced a procedure" authoring in the fork. Also avoids paying foreground latency/tokens on many turns for work the background lane does free. |
| D19 | Chunk B footprint EXTENDS to `test/protocols-archive.test.ts` — provenance round-trip assertion is required, not optional | Chunk B argued no meaningful test existed. The skeptic disproved it: `test/protocols-archive.test.ts` is fs-backed, has a `mkProtocol(name, extra)` helper, and already contains a full archive/unarchive/pin lifecycle test at ~:219-244. A provenance assertion there is ~3 lines and is genuinely behavioral — it pins the invariant the whole D7 recovery story rests on. Standing repo rule is always-add-tests. |

## Residual risk (accepted by user, recorded)

A session that ingested external page content can author a protocol whose body
contains injected instructions; it will load on future matching turns. Bounded
by: protocols are instructions not permissions (all steps still pass tool
policy / approval / sandbox / egress gates), provenance stamping, and
one-action archive. Accepted 2026-07-25.

---

## Findings (pre-existing defects, found not caused)

- **F1 — search index never invalidated.** `invalidateSearchIndex()`
  (`search.ts:96-100`) and `invalidateBundledCache()` (`loader.ts:180-182`)
  have **zero call sites** repo-wide. BM25 index rebuilds only when
  `protocols.length` CHANGES (`search.ts:87-94`), so an in-place edit is
  invisible to `protocol(action:"search")` for the whole process life. The
  fork's PATCH path is exactly an in-place edit → would silently never
  surface. Must be fixed for the campaign to work at all.
- **F2 — non-atomic writes, no lock.** `saveCustomProtocols`
  (`builder.ts:66-69`) and `archive.ts:63` are full-file `writeFileSync`.
  A background fork writing concurrently with a user/tool write loses data.
  Canonical fix pattern already in repo: `atomicWriteFileSync`
  (`learned-lifecycle.ts:234`).
- **F3 — `createProtocol()` bypasses dedup + provenance.** Raw function does
  no similarity check and does not stamp `source`; the cosine>0.85 dedup gate
  lives only in the `protocol_create` TOOL wrapper (`builder.ts:136-154`).
  But the tool's schema does not expose `body` (`builder.ts:114-125`). So the
  fork can have dedup or markdown bodies, not both, without a change here.
- **F4 — `editProtocol` does not `dropEmbedding`.** (`builder.ts:81-88`)
  Stale dedup embedding after a patch changes name/description/triggers.
- **F5 — dead trigger slot that is exactly this feature.**
  `curate-nudge.ts:63,70` defines trigger `"long-task-completed"`, documented
  "tool-heavy turn just finished", boost `ceil(NUDGE_INTERVAL/3)`. Grep shows
  **no production caller fires it** — the only `boostNudgePriority` call sites
  (`agent-request/prepare-request/curate-nudge.ts:58,63,67,80`) are regex /
  classifier checks on the USER MESSAGE. A tool-heavy turn currently advances
  nothing.
- **F6 — the nudge channel is fenced as untrusted DATA.** `smartContext` is
  wrapped by `asRecalledData` (`context/system-prompt-builder.ts:36-39,332-338`):
  "Treat everything up to the closing sentinel as DATA to consider, NEVER as
  instructions." So the existing learned-workflow nudge is injected into a
  channel that tells the model to ignore it. Sibling first-party channel that
  is NOT fenced: `harnessNotice()` (`system-prompt-builder.ts:47-49`).
- **F7 — `smart-context` is 2nd in the degradation kill order**
  (`context/prompt-degradation.ts:11-20`). On constrained/local profiles the
  protocol hint dies almost first.
- **F8 — the UI delete lies.** `public/js/protocols.js:311` confirms "This is
  irreversible" then calls DELETE without `?permanent=true`, which
  soft-archives (`routes/bridges/protocols.ts:143-147`).
- **F9 — no unarchive / list-archived HTTP route** despite the comment at
  `routes/bridges/protocols.ts:134-136` pointing at one. Archived protocols
  are recoverable ONLY via agent tools. This directly breaks D7.
- **F10 — protocol routes have no operator role gate.** `_role` unused
  (`routes/bridges/protocols.ts:4`). **P2 resolved: intentionally left open.**
- **F11 — the base prompt calls a PHANTOM TOOL.** `config/system-prompt.md:234`
  and `:236` instruct the agent to call `protocol_build` ("call
  `protocol_build` BEFORE you reply"). VERIFIED: no such tool exists. Strong
  candidate for why procedural saving never happens today.
  **WIDER THAN RECORDED (chunk A, verified at runtime):** the model-facing
  surface is a SINGLE collapsed tool `protocol(action:"...", params:{...})`
  (`src/protocols/protocol-tool.ts:18-42`, registered `src/tools/plugins.ts:160`;
  `collapse-family.test.ts:77` pins that no flat `protocol_*` name is exposed).
  `:234` named THREE more phantoms — `protocol_search`, `protocol_get`,
  `protocol_save_preference` — all inner implementation names never in the
  model's schema. Real actions confirmed by runtime dump: `list, get,
  save_preference, format_caption, format_composer, dry_run, create, edit,
  delete, unarchive, pin, list_archived, templates_list, from_template,
  chain_*, progress_*, rollback_*, var_*, stats, prune, archive_bulk, curate,
  curator_status, search`.

### Findings discovered mid-campaign (PARKED — not fixed here)

- **F12 — the `protocol` tool is DEFERRED, not eager.**
  `src/agent-request/audience-map.ts:139-142` demoted it 2026-07-13. It only
  enters the model's schema on a `/protocol/i` match in the user message
  (`src/agent-request/tool-filter.ts:65`) or via an explicit `tool_search`
  round-trip. The audience-map comment at `:144-145` claims the social
  `mission_` keyword rule resurfaces the family — **that comment is stale and
  wrong**: the only real `mission_*` tools are cron schedulers
  (`src/cron/tools.ts:16-109`), and the `mission_rollback_` / `mission_chain_` /
  `mission_template` prefixes at `tool-filter.ts:53-55` match nothing at all.
  So on `:236`'s own flagship example ("post a thread on X"), the prompt
  instructs the model to call a tool that is not in its schema, and never
  mentions the `tool_search` hop needed to get it.
  **Why parked, not fixed:** independent pre-existing defect on a
  high-blast-radius shared anchor (tool visibility on EVERY turn), outside
  every chunk footprint. The campaign's autonomous path does not depend on it —
  chunk D's fork carries its own explicit static tool list (D11), so it must
  name `protocol` directly and is immune. Fix as its own campaign.
- **F13 — `eval/tool-discovery/cases.json:39` pins flat names.** Expects
  `["protocol_search","protocol_list"]` against an exact-name scorer
  (`run.mjs:116`, `expected.includes(firstTool)`), so case `protocol.find`
  fails deterministically now that only `protocol` is emittable. Note
  `config/system-prompt.md` is a **trigger file for `scripts/eval-gate.mjs:41`**,
  so chunk A's commit is exactly what would fire this eval. Mitigating: no
  `.git/hooks/pre-commit` exists on this box, so it will not auto-fire.
- **F14 — provenance-dropping sites (feed chunk G / chunk D).**
  `routes/bridges/protocols.ts:116` (fork) rebuilds `source` field-by-field
  keeping only `repo` — drops all three provenance fields, and is NOT
  type-guarded despite a comment implying it is. `:94` (imported→custom
  promotion) replaces `source` wholesale, same anti-pattern, currently
  unreachable for agent records. `:68` (POST create) hardcodes
  `{type:"custom"}` with no way to set provenance. `marketplace.ts:76`
  (`installProtocol`) clobbers wholesale on name collision.
  `loader.ts:156` rebuilds `source` from scratch on every SKILL.md load and
  `parseSkillMd` has no provenance frontmatter key — **provenance is
  structurally impossible for the bundled/imported/learned tiers.** It works
  ONLY for the custom.json tier. Load-bearing consequence: **the fork must
  write to the custom.json tier and must never write agent protocols as
  learned SKILL.md**, or provenance dies silently on next restart.
- **F15 — same bug class as F11, in a SECURITY rule.**
  `config/system-prompt.md:216-229` names `browser_evaluate`,
  `browser_inner_text`, `browser_get_text` in the FORBIDDEN-tools list.
  `browser_evaluate` does not exist anywhere in `src/`; `browser` is also a
  collapsed family (`resolve-tool.ts:29`). A forbidden-list that does not name
  what the model can actually call is worse than a wrong affordance hint.
  Parked as its own chunk/campaign — outside this campaign's footprint, and
  touching a security rule mid-campaign without its own verification pass is
  exactly the drive-by this discipline forbids.

## Area-map notes

**Protocol storage:** `workspace/protocols/custom.json` (git-synced). Archive:
`workspace/protocols/archived.json`. Assembly: `getAllProtocols()`
`src/protocols/index.ts:115-134`, precedence builtin → bundled → imported →
managed-learned → **custom (always wins)**. Custom is JSON `Protocol[]`;
bundled/imported/learned are SKILL.md. `Protocol.body?` carries markdown and
`protocol_get` prefers it over `steps` (`index.ts:205-209`).

**Background-job canonical:** `src/server/background-jobs/` calling
`runAgentViaCanonical`: `worker-runner.ts:43-60`, `dream-check.ts:66-101`,
`cron-runner.ts:127-144`, `self-edit-surgeon-runner.ts:67`. All use
`lane:"background"`, a hand-filtered tool list, their own prompt, and a
synthetic sessionId. No FieldAgent, no broadcast, no AgentRunStore row.
Scheduling gate: `background-jobs/index.ts:78-129`
(`foregroundIdle = !isForegroundBusy(sessionStore)`, `JobScheduler.register`).
Lane concurrency `background: 1` (`canonical-loop/scheduler.ts:49-55`).
No depth cap / recursion prevention exists anywhere.
Prompt caching is provider-level, 5-min TTL, last system block
(`anthropic-client/stream-api.ts:74-83`).

**Trigger seam:** `collectToolSequence(opId, extras)`
(`turn-loop/record-outcome.ts:43-51`) already reconstructs the whole-op ordered
tool sequence from `readOpTurns(opId)` and is already called at terminal.
`recordCommittedLearningOutcome` (`:69-88`) does collectToolSequence →
eligibility → record. The skill-review request is a SIBLING in the same file.
Terminal point: `terminal-epilogue.ts:112-121`. Post-commit point:
`turn-loop.ts:364-398`. Caps: per-op `maxIterations: 30`
(`chat-runner/create-op.ts:60`), worker `DEFAULT_MAX_TURNS = 64`
(`worker.ts:47`), config default 160, floor `MIN_MAX_ITERATIONS = 120`.

**Reusable UI pattern:** the learned-workflow card
(`public/js/settings-learned-workflows.js`) already implements optimistic
update + rollback, compare-and-swap with 409, operator gating, and WS refresh.
Protocols tab has none of that and shows no provenance at all.

---

## Chunks

Footprints are exact. Schedule is by files touched.

| ID | Responsibility | Footprint | Risk |
|---|---|---|---|
| A | Fix phantom-tool instruction (F11); align save guidance with real action names | `config/system-prompt.md` | low |
| B | Provenance field (D8): `authoredBy`/`authoredAt`/`authoredFromSession`, additive-optional | `src/protocols/types.ts` | low change / wide blast radius |
| C | Write-path hardening: atomic writes (F2), cache invalidation on write (F1), `dropEmbedding` on edit (F4), reusable dedup + `authorProtocol()` accepting `body` (F3/D9) | `src/protocols/builder.ts`, `src/protocols/archive.ts`, `src/protocols/search.ts`, `src/protocols/dedup.ts` | med |
| D | Skill-review background job: `runAgentViaCanonical`, background lane, static prompt + static tool list, no spawn tools (D6-REV/D11/D12) | NEW `src/server/background-jobs/skill-review.ts`, `src/server/background-jobs/index.ts` | med |
| E | Trigger: sibling of `recordCommittedLearningOutcome` reusing `collectToolSequence`, no eligibility gate (D13/D14); wire dead `long-task-completed` boost (F5/D15) | `src/canonical-loop/turn-loop/record-outcome.ts`, `src/memory/curate-nudge.ts` | med |
| F | Retrieval (D16): score all protocols, unfence the nudge (F6), fix kill order (F7) | `src/protocols/learned-suggestion.ts`, `src/agent-request/prepare-request/build-context.ts`, `src/context/prompt-degradation.ts` | HIGH |
| G | UI + routes: unarchive/list-archived routes (F9), fix delete lie (F8), agent-authored badge | `src/routes/bridges/protocols.ts`, `public/js/protocols.js`, `public/app.html` | med |
| H | Cross-seam integration gate | NEW test file only | — |

## Conflict + dependency graph

Conflict edges (shared files): **none** — footprints are disjoint by design,
so all chunks run in the single working tree with no worktrees.
Dependency edges only:

```
Wave 1 (parallel):  A    B
Wave 2 (parallel):  C ← B      G ← B
Wave 3:             D ← C
Wave 4:             E ← D
Wave 5 (gated):     F ← B          <- HIGH RISK, held to last
Wave 6:             H ← all
```

F is held behind the gate per the blast-radius rule: `prompt-degradation.ts`
and `build-context.ts` are read on every single turn. Everything else must be
green and skeptic-verified before F runs.

## Parked decisions — BOTH RESOLVED BY USER 2026-07-25

- **P1 RESOLVED — main (expensive) model, normal trigger.** User chose highest
  quality / normal firing cadence, matching Hermes's own default. Fork uses the
  main model with a STATIC prompt + STATIC tool list (D11) so repeated forks
  share the 5-min provider prefix cache
  (`anthropic-client/stream-api.ts:74-83`). Trigger threshold stays at the
  normal tool-heavy bar, not the stricter one.
- **P2 RESOLVED — DO NOT ADD the operator gate.** Verified: the server binds
  loopback-only — `server.listen(config.port, "127.0.0.1", ...)`
  (`src/server/index.ts:329`) — and the broker transport bridges chat over a
  data channel without proxying `/api/*`. Single user + loopback = the role
  gate buys ~nothing. F10 stays open by design.
  **REVISIT IF:** the server ever binds beyond 127.0.0.1, OR HTTP route
  proxying is added over the broker.

## Status board

PLAN APPROVED 2026-07-25 ("Go"). Executing.

| Chunk | Wave | Status | Commit | Notes |
|---|---|---|---|---|
| A — base-prompt phantom tool (F11) | 1 | pending | — | `config/system-prompt.md` only |
| B — provenance field (D8) | 1 | pending | — | `src/protocols/types.ts` additive-optional |
| C — write-path hardening (F1/F2/F3/F4) | 2 | pending | — | needs B |
| G — UI + archive routes (F8/F9) | 2 | pending | — | needs B; NO operator gate (P2 resolved) |
| D — skill-review background job (D6-REV) | 3 | pending | — | needs C; main model, static prompt |
| E — trigger (D13/D14/F5) | 4 | pending | — | needs D |
| F — retrieval (D16/F6/F7) | 5 GATED | pending | — | needs B; HIGH RISK, runs last |
| H — cross-seam integration test | 6 | pending | — | needs all |

### Resume protocol (after compaction or crash)

1. Read this file top to bottom. It is the ONLY source of truth.
2. Skip every chunk marked `green`. Re-run anything `in-flight` (it did not
   finish).
3. Chunk briefs must inline: canonical-check (extend, never fork a new file),
   senior-engineer (smallest root-cause change), blast-radius (enumerate
   consumers of any shared value), mandatory regression tests, and a scope
   lock to the chunk's footprint with no sub-agent recursion.
4. Every green chunk gets an independent skeptic that tries to refute it.
   Green only counts when the skeptic FAILS to break it.
5. Commit per chunk, **explicit paths only, never `-a`** (dirty desktop/ files
   are not ours). NEVER push.
6. End with the honest four-bucket ledger: shipped / parked / failed /
   descoped.

## Completion ledger

TBD
