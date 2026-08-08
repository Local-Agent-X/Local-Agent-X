# Self-learning protocols

Local Agent X mines its own proven workflows into reusable **learned protocols**
— versioned, outcome-scored `SKILL.md` procedures that are drafted from real
successful runs and (optionally) activated and surfaced automatically on future
matching requests, without ever expanding the user's existing permissions.

This is the reference for the feature as it ships. The two root-level
`CAMPAIGN-SELF-LEARNING.md` / `CAMPAIGN-PROCEDURAL-LEARNING.md` files are build
ledgers (chunk tables and verification history from the campaigns that built
this) and describe two forks of the work — treat them as history, not as a
description of current behavior. This doc is the source of truth for what runs.

## At a glance

- **Config:** `learningMode` ∈ `{ "assisted", "autonomous" }`, default **`assisted`**
  (`src/config-schema.ts:44`). It's a `protected` runtime setting — flipping it to
  `autonomous` goes through the protected-setting approval gate.
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
| `learner.ts` | Singleton `CrossSessionLearner`: records outcomes, mines patterns, captures/transitions candidates, picks the next learning opportunity. |
| `detectors.ts` | Pattern miners; `detectOutcomeWorkflows` groups committed outcomes by `category:tool-sequence` and computes success / weighted-success rates. |
| `suggestions.ts` | Turns a detected pattern into an `AutomationSuggestion` + `LearnedCandidate`; computes confidence. |
| `service.ts` | `CrossSessionLearningService`: `list`/`detail`/`action` for the HTTP API, and `reconcile(mode)` — the engine that drives auto draft/activate/refine/rollback/archive. |
| `persistence.ts` | SQLite-mutex-guarded JSON evidence store at `~/.lax/cross-session-data.json`, plus `autoPrune`. |
| `types.ts` | Types, the evidence-authority identities, and hardened structural validators that gate what counts as trusted evidence. |
| `text-utils.ts`, `index.ts` | Tokenizing/fuzzy-match helpers; barrel exporting the singleton. |

**Learned-protocol lifecycle** — `src/protocols/`
| File | Responsibility |
|---|---|
| `learned-lifecycle.ts` | On-disk state machine (draft → active → archived, rollback/restore) with per-version content, sha256 verification, activation history, and path/symlink containment. |
| `learned-lifecycle-transaction.ts` | Wraps every lifecycle mutation in a SQLite `IMMEDIATE` transaction (cross-process mutex). |
| `learned-drafting.ts` | Re-validates a candidate's outcome evidence from scratch, renders a deterministic `SKILL.md`, writes a draft version. |
| `learned-effectiveness.ts` | Append-only, lock-guarded outcome ledger; computes per-version quality metrics. |
| `learned-refinement.ts` | Pure predicates: is a version a strong-enough refinement to auto-promote; does recent data demand a safety rollback/archive. |
| `learned-suggestion.ts` | Ranks active learned + custom protocols against a user message and returns the single best "load this protocol" nudge, or null. |

**Wiring / API / UI**
| File | Responsibility |
|---|---|
| `src/tool-execution/learned-protocol-envelope.ts` | Per-tool-call gate enforcing the active protocol's `allowedTools` envelope. |
| `src/routes/memory-learning.ts` | HTTP surface: reads for any role, operator-gated lifecycle mutations. |
| `public/js/settings-learned-workflows.js` | Settings: workflow list + inspector, activate/reject controls (assisted mode). |
| `public/js/settings-learning-mode.js` | Settings: the assisted/autonomous toggle. |

## End-to-end flow

1. **Evidence capture** — when an op terminates, `recordCommittedLearningOutcome`
   (`src/canonical-loop/turn-loop/record-outcome.ts`) records only
   `{opId, sessionId, outcome, category, tools[], model, timestamp}` via
   `crossSessionLearner.recordOutcome`. `isLearningOutcomeEligible` drops the
   evidence entirely if the session had external ingestion, taint, or an external
   (non-`mcp__lax__`) tool — the run itself is never interrupted; it just doesn't
   train later behavior.
2. **Mining → candidate** — `nextLearningOpportunity` → `detectOutcomeWorkflows`
   marks a group `automationEligible` when `clean ≥ 3`, `successRate ≥ 0.75`,
   `weightedSuccessRate ≥ 0.75` (14-day half-life), and `distinctSessions ≥ 2`.
   `captureCandidate` mints a stable `learned-<sha20>` id with a 7-day
   re-surface cooldown.
3. **Draft** — `draftLearnedCandidate` (`src/protocols/learned-drafting.ts`)
   re-checks the proof independently and writes
   `~/.lax/protocols/learned/<slug>/versions/<uuid>/{SKILL.md,meta.json}`. The
   drafted `allowed-tools` are exactly the de-duplicated observed tool sequence.
4. **Effectiveness** — while an op runs under a selected learned protocol,
   `prepareCanonicalLearnedOutcome` (`src/canonical-loop/learned-effectiveness.ts`)
   writes a `pending` receipt keyed to the envelope, flipped to `committed` only on
   a terminal state. `qualityScore = (clean + 0.5·partial) / total`.
5. **Reconcile** — the orchestrator meta-signal `cross-session-learning`
   (`src/orchestrator/signals-meta.ts`, every 5th message) calls
   `service.reconcile(getRuntimeConfig().learningMode)`. Safety recovery
   (rollback/archive on sustained regression) runs in **both** modes. Auto-activate
   and auto-promote-refinement run **only in `autonomous`**.
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

## `learningMode`

| Mode | Behavior |
|---|---|
| `assisted` *(default)* | Drafts candidates and surfaces a review nudge; the UI shows activate/reject. Never auto-activates. Existing trusted protocols may still be selected. |
| `autonomous` | The protected autonomous learning mode: auto-drafts, auto-activates qualified drafts, auto-promotes stronger refinements, and performs safety rollback/archive — all in-process, within existing permissions, no per-protocol prompt. |

Read at `src/orchestrator/signals-meta.ts` (reconcile driver) and
`src/routes/memory-learning.ts` (returned to the UI). Declared `runtime`,
`protected`, `broadcast` in `src/settings-schema.ts`.

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
  `403 Operator role required` unless the caller holds the operator role. Autonomous
  reconciliation performs the same lifecycle work in-process, not through the HTTP
  path.
- **Concurrency** — lifecycle mutations run under a SQLite `IMMEDIATE` mutex,
  effectiveness writes under a dir-lock with stale-owner reclaim, evidence writes
  under a SQLite mutex; the HTTP path uses compare-and-swap on the active version
  (`409` on stale).

## Persistence & restart repair

| Data | Location | Restart repair |
|---|---|---|
| Action/candidate evidence | `~/.lax/cross-session-data.json` | `normalizeLegacyEvidenceIdentities` + `autoPrune` on load. |
| Learned protocols | `~/.lax/protocols/learned/<slug>/` (`learned.json`, `versions/<uuid>/…`, root `SKILL.md` while active) | Full integrity re-verification on every read; `service.reconcile` rebuilds a missing managed protocol from local evidence. |
| Effectiveness receipts | `<workspace>/protocols/effectiveness/outcomes/<sha256(opId)>.json` | `reconcileCanonicalLearnedOutcomes()` at boot (`src/server/canonical-loop-bootstrap.ts`) commits terminal pendings, quarantines mismatches, drops stale missing-op receipts. |

## HTTP API — `src/routes/memory-learning.ts`

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/api/memory/learning` | any authenticated role | `{ mode, items[] }` summaries. |
| GET | `/api/memory/learning/:id` | any authenticated role | `{ item }`; `400` bad id, `404` unknown. |
| POST | `/api/memory/learning/:id/action` | **operator only** (`403` otherwise) | `{action, versionId?, expectedActiveVersionId}`; actions `activate\|reject\|archive\|restore\|rollback`; CAS → `409` on stale; broadcasts `learning_changed`. |

Ids match `^learned-[a-f0-9]{20}$`; `versionId`s are UUIDs.
