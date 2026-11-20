# Self-learning protocols

Local Agent X turns what a run learned into reusable **learned protocols** —
versioned, outcome-scored `SKILL.md` procedures proposed by a post-turn review
of real runs, activated by the user or by independent evidence, and surfaced on
future matching requests, without ever expanding the user's existing permissions.

**One admission rule, one write path.** Every draft enters the tier through
`createLearnedProtocolDraft` (`src/protocols/learned-lifecycle.ts`), which runs
`draftAdmissionProblem` (`src/protocols/learned-proposal-gate.ts`) on the
SKILL.md it is about to store: a reviewed proposal must quote the thing the
agent could not have derived and carry a class-level name; a protocol that was
already the user's (migration) has nothing to judge; anything else is refused.
Until 2026-11-20 a second producer, a tool-sequence miner, drafted "workflows"
straight from repeated tool sequences on its own path around this rule
("memory_search then memory_search …": 26 drafts and no keeps on one machine).
It was retired. Drafts it left on disk stay drafts until the user keeps or
rejects them.

This is the reference for the feature as it ships. The two root-level
`docs/history/campaign-self-learning.md` / `docs/history/campaign-procedural-learning.md` files are build
ledgers (chunk tables and verification history from the campaigns that built
this) and describe two forks of the work — treat them as history, not as a
description of current behavior. This doc is the source of truth for what runs.

## At a glance

- **Config:** `learningMode` (`assisted` / `autonomous`) is still stored and shown in
  Settings, but nothing reads it since the miner was retired; see `learningMode` below.
- **A learned protocol can only restrict capability, never expand it.** While an op
  runs under one, its tool calls are confined to the protocol's verified
  `allowedTools`; every underlying action still hits its normal Ari, policy,
  approval, sandbox, workspace, and egress gates.
- **Trust root:** system-managed learned protocols live in the machine-local
  `~/.lax/protocols/learned/` store, loaded *after* workspace imports so a
  workspace forgery can't masquerade as managed.
- **Only clean, un-tainted, non-external evidence trains behavior.** Sessions with
  external ingestion, taint, or external MCP tools are excluded from evidence; only
  tool *names* are recorded — never arguments or results.

## Modules

**Cross-session cognition** — `src/cognition/cross-session-learning/`
| File | Responsibility |
|---|---|
| `learner.ts` | Singleton `CrossSessionLearner`: records run outcomes, records reviewed proposals, and transitions/projects candidates. |
| `candidate-revision.ts` | Candidate state transitions and the projection path from a lifecycle state to the candidate's. |
| `reviewed-procedures.ts` | Records a review proposal as evidence on its candidate; the discard cooldown. |
| `service.ts` | `CrossSessionLearningService`: `list`/`detail`/`action` for the HTTP API, and `reconcile()`: probation rollback/archive, resuming an interrupted approval, projection healing, and activating a reviewed procedure on independent evidence. It never drafts. |
| `persistence.ts` | SQLite-mutex-guarded JSON evidence store at `~/.lax/cross-session-data.json`, plus `autoPrune`. |
| `types.ts` | Types, the evidence-authority identities, and hardened structural validators that gate what counts as trusted evidence. |
| `index.ts` | Barrel exporting the singleton. |

**Learned-protocol lifecycle** — `src/protocols/`
| File | Responsibility |
|---|---|
| `learned-lifecycle.ts` | On-disk state machine (draft → active → archived, rollback/restore) with per-version content, sha256 verification, activation history, and path/symlink containment. |
| `learned-lifecycle-transaction.ts` | Wraps every lifecycle mutation in a SQLite `IMMEDIATE` transaction (cross-process mutex). |
| `learned-proposal-gate.ts` | The admission rule every draft passes (`draftAdmissionProblem`): derivability and class-level names. |
| `learned-review-drafting.ts` | `proposeReviewedProcedure`: the review fork's write path, and migration's. |
| `learned-effectiveness.ts` | Append-only, lock-guarded outcome ledger; computes per-version quality metrics. |
| `learned-refinement.ts` | Pure predicates: when a reviewed procedure has earned a card or activation, and whether recent outcomes demand a safety rollback/archive. |
| `learned-suggestion.ts` | Ranks active learned + custom protocols against a user message and returns the single best "load this protocol" nudge, or null. |

**Wiring / API / UI**
| File | Responsibility |
|---|---|
| `src/tool-execution/learned-protocol-envelope.ts` | Per-tool-call gate enforcing the active protocol's `allowedTools` envelope. |
| `src/routes/memory-learning.ts` | HTTP surface: reads for any role, operator-gated lifecycle mutations. |
| `public/js/settings-learned-workflows.js` | Settings: workflow list + inspector, activate/reject controls (assisted mode). |
| `public/js/settings-learning-mode.js` | Settings: the assisted/autonomous toggle (no longer read; see below). |

## End-to-end flow

1. **Proposal** — the post-turn review (below) proposes a procedure through
   `proposeReviewedProcedure`, which records the session as evidence on a
   `learned-<sha20>` candidate and writes a draft version to
   `~/.lax/protocols/learned/<slug>/versions/<uuid>/{SKILL.md,meta.json}` through
   the one admission rule. Its `allowed-tools` are the reviewed run's tools.
2. **Activation** — the user keeps it (chat card or Settings), or reconcile
   activates it once three distinct sessions proposed it from runs that held up.
3. **Run log** — when an op terminates, `recordCommittedLearningOutcome`
   (`src/canonical-loop/turn-loop/record-outcome.ts`) still records
   `{opId, sessionId, outcome, category, tools[], model, timestamp}`. Since the
   miner was retired nothing reads it. `isLearningOutcomeEligible` still decides
   which runs may write an effectiveness receipt (step 4): none with external
   ingestion, taint, or an external (non-`mcp__lax__`) tool.
4. **Effectiveness** — while an op runs under a selected learned protocol,
   `prepareCanonicalLearnedOutcome` (`src/canonical-loop/learned-effectiveness.ts`)
   writes a `pending` receipt keyed to the envelope, flipped to `committed` only on
   a terminal state. `qualityScore = (clean + 0.5·partial) / total`.
5. **Reconcile** — the orchestrator meta-signal `cross-session-learning`
   (`src/orchestrator/signals-meta.ts`, every 5th message) calls
   `service.reconcile()`: safety rollback/archive of a regressing active version,
   resuming an approval a crash interrupted, projection healing, and step 2's
   activation on independent evidence. A newer version of an active procedure
   is activated only by the user.
6. **Surface (read)** — `getLearnedProtocolSuggestion(message)`
   (`src/protocols/learned-suggestion.ts`) is called from
   `src/agent-request/prepare-request/build-context.ts`, which injects a per-turn
   `LEARNED WORKFLOW` harness notice asking the model to `protocol(action:"get", …)`
   before acting. Only verified-active learned records (and non-learned `custom`
   protocols) are eligible to surface.
7. **Envelope binding (execute)** — when the model loads the protocol via
   `protocol_get`, `src/protocols/index.ts` registers the
   `{slug, versionId, candidateId, allowedTools}` envelope for the op, and every
   subsequent tool call passes through `learnedProtocolEnvelopeGate`
   (`src/tool-execution/learned-protocol-envelope.ts`).

## Post-turn review (reviewed procedures)

The second way a learned protocol comes to exist. After a user-facing chat turn
that made ≥4 tool calls across ≥2 distinct tools, `requestSkillReviewForOp`
(`record-outcome.ts`) queues the op; once the user sends another message (or 30
minutes pass) an idle-time fork of the MAIN model reads the transcript
(`src/server/background-jobs/skill-review*.ts`) with one tool, `protocol`,
narrowed to `list`/`get`/`search`/`propose`/`note_gap`.

What a proposal must carry (`src/protocols/learned-proposal-gate.ts`, enforced
at the one draft write path `createLearnedProtocolDraft`, and checked first in
`proposeReviewedProcedure` so a refused proposal is never recorded as evidence):

- **Derivability.** `learned: {kind, detail}` names the one thing the agent
  could not have derived from its tools and the repo — an `external_string`,
  a `pitfall`, a `user_correction`, or a `precondition` — and `detail` must
  appear verbatim in the body. An `external_string` or `precondition` claim
  also needs an egress-class tool (`hasCapability(tool, "egress")`) in the
  reviewed run's own tool sequence: a run that never left the machine found
  nothing about an external system. The fork's system prompt carries an
  inventory of every registered tool (`buildSkillReviewSystemPrompt`) so "the
  agent already has this" is a judgement it can make.
- **Class-level name.** A name carrying a project the run worked in or a
  session-artifact word (`…_audit`, `…_debrief`, `…_walkthrough`) is refused.
  Project names come from two sources: directories under the workspace root
  and `workspace/apps`, and the first path segment under the home dir or the
  workspace in the reviewed op's own tool-call paths
  (`skill-review-project-names.ts`), so `jobs_in_order_crm_master_push` is
  refused wherever that repo lives. A recipe for the user's own repo is
  derivable from the repo.
- **Tool gaps are not skills.** "Call tool X, and when it misses, do Y" goes to
  `note_gap`, which appends to `~/.lax/capability-gaps.jsonl`
  (`src/cognition/cross-session-learning/capability-gaps.ts`) for the
  maintainer. It never becomes a draft.

A first proposal drafts silently. The chat's Keep/Discard card
(`learning_notice`) appears only once `REVIEWED_PROCEDURE_NOTICE_SESSIONS` (2)
distinct sessions proposed the same procedure from runs that held up;
`REVIEWED_PROCEDURE_MIN_SESSIONS` (3) activates it without asking. Migrated
catalog protocols (`origin: "migration"`, outcome `unverified`) skip the gate
and are reviewable at once — they were already the user's.

`skillReviewEnabled` (default `true`; runtime, broadcast, protected) turns the
review off entirely, and with it the only way a new learned procedure is born.

## `learningMode`

Both modes now behave the same. The mode used to decide whether the miner's
drafts and their stronger refinements activated without asking; with the miner
retired, `reconcile()` takes no mode and `src/orchestrator/signals-meta.ts` no
longer reads it. It is still declared `runtime`, `broadcast` and owner
`protected` in `src/settings-schema.controls.ts`, returned by
`src/routes/memory-learning.ts`, and shown as a toggle in Settings.

## Safety invariants (enforced in code)

- **Capability containment** — `learned-protocol-envelope.ts` blocks any tool not in
  the active version's `allowedTools`, and re-derives the active on-disk provenance
  every call, blocking if `versionId`/`candidateId`/`allowedTools` drift. It can only
  narrow capability.
- **Trust root integrity** — every path under `~/.lax/protocols/learned/` is
  containment- and symlink-checked; slugs must match `^learned-[a-f0-9]{20}$`;
  version bodies are sha256-verified against `meta.json` / `learned.json` on every
  load. Managed protocols load after workspace imports.
- **Evidence hygiene** — `isLearningOutcomeEligible` excludes external-ingestion,
  taint, and external-MCP sessions; only tool names are stored; evidence-authority
  identities plus prototype-poisoning-hardened validators reject records lacking the
  exact expected authority.
- **Operator-gated mutation API** — any `POST …/action` returns
  `403 Operator role required` unless the caller holds the operator role.
  Reconciliation performs its lifecycle work in-process, not through the HTTP path.
- **Concurrency** — lifecycle mutations run under a SQLite `IMMEDIATE` mutex,
  effectiveness writes under a dir-lock with stale-owner reclaim, evidence writes
  under a SQLite mutex; the HTTP path uses compare-and-swap on the active version
  (`409` on stale).

## Persistence & restart repair

| Data | Location | Restart repair |
|---|---|---|
| Action/candidate evidence | `~/.lax/cross-session-data.json` | `normalizeLegacyEvidenceIdentities` + `autoPrune` on load. |
| Learned protocols | `~/.lax/protocols/learned/<slug>/` (`learned.json`, `versions/<uuid>/…`, root `SKILL.md` while active) | Full integrity re-verification on every read; a candidate whose record is missing stays without one (`reconcile` never drafts). |
| Effectiveness receipts | `<workspace>/protocols/effectiveness/outcomes/<sha256(opId)>.json` | `reconcileCanonicalLearnedOutcomes()` at boot (`src/server/canonical-loop-bootstrap.ts`) commits terminal pendings, quarantines mismatches, drops stale missing-op receipts. |

## HTTP API — `src/routes/memory-learning.ts`

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/api/memory/learning` | any authenticated role | `{ mode, items[] }` summaries. |
| GET | `/api/memory/learning/:id` | any authenticated role | `{ item }`; `400` bad id, `404` unknown. |
| POST | `/api/memory/learning/:id/action` | **operator only** (`403` otherwise) | `{action, versionId?, expectedActiveVersionId}`; actions `activate\|reject\|archive\|restore\|rollback`; CAS → `409` on stale; broadcasts `learning_changed`. |

Ids match `^learned-[a-f0-9]{20}$`; `versionId`s are UUIDs.

## Recurring problems and lessons (the failure review)

Everything above learns from runs that worked. This is the other half: a tool
call that fails the same way in several chats. It shares the Settings card and
nothing else; a lesson is not a protocol and never enters the catalog.

**The flow**

1. **Record.** Every failed call in `~/.lax/telemetry/tool-usage.jsonl` says
   which failure it was: a signature over the tool, its action, the status, the
   gate that refused it and the normalized first line of the result. A call the
   user declined, one waiting on a person, and a replayed result are not counted.
2. **Count.** No model. A failure is *recurring* at 3 chats on 2 calendar days,
   seen in the last 3 days, within a 14-day window. The dream, skill-review,
   eval and failure-review sessions are not counted; a scheduled job's run and
   an app-builder chat are.
3. **Review.** About once a day, on the foreground-idle gate, up to 5 recurring
   failures nothing has been decided about get one tool-less fork each on the
   user's main model. Its reply is one JSON object: `lesson`, `app_gap` or
   `noise`. A refused (`blocked`) call is listed but never reviewed.
4. **Keep.** A lesson is `proposed` until the user keeps it (inbox item plus
   Settings → Memory → Recurring problems). In either `learningMode`.
5. **Deliver.** A kept lesson follows the error in the result of a call that
   just failed the same way, fenced as recalled data, once per run for the same
   work. After the error, never before: the result's first line is what the
   failure nudge, the constraint ledger and the repeat-failure breaker read. It
   is never in the prompt of a turn that did not hit the failure.
6. **Retire.** The same work succeeding later in that run is a recovery. A
   lesson shown 5 times that helped less than 2 times in 5 retires itself.

**Enforced in code, not the prompt:** a lesson needs a sample in which the same
call then succeeded, its text passes the memory write gate, and it is at most
300 characters. Anything else is stored as noise.

`failureReviewEnabled` (default `true`; runtime, broadcast, protected) turns
the review off. Counting, the list, and lessons already kept are untouched.

| File | Responsibility |
|---|---|
| `src/tools/failure-signature.ts` | The one normalizer and signature, shared with the in-run constraint ledger. |
| `src/tool-execution/failure-record.ts` | What a failed call adds to the usage log. |
| `src/cognition/cross-session-learning/failure-patterns.ts` | Groups the window's failures and decides which are recurring. |
| `src/cognition/cross-session-learning/known-failures.ts` | Verdicts, lessons and their state at `~/.lax/known-failures.json`, written under the learned-lifecycle cross-process lock; the retire rule. |
| `src/canonical-loop/public/op-tool-failures.ts` | Reads a past run's failed calls and renders one as evidence. |
| `src/server/background-jobs/failure-backfill.ts` | One-time: writes the last two weeks of past failures into the log. |
| `src/server/background-jobs/failure-review.ts` | The daily pass; `failure-review-prompt.ts` is its static prompt and reply parser. |
| `src/server/background-jobs/review-fork.ts` | The timeout and failed-run rule both review jobs fork under. |
| `src/tool-execution/known-failure-note.ts` | Puts a kept lesson on a failed result and counts recoveries. |
| `src/routes/memory-problems.ts` | `GET /api/memory/problems`; `POST /api/memory/problems/:signature/action` `{action: keep\|discard}`, operator only, broadcasts `settings_changed`. |
| `public/js/settings-recurring-problems.js` | The Recurring problems list with Keep and Discard. |
