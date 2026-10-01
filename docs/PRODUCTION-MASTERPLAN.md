# Local Agent X — production masterplan

Written 2026-10-01 against `main` at `dc5b2c4`. This is the plan for getting LAX
from "research-grade, active development" to a build that does what the README
says, every time, on a fresh install. It is grounded in what the repository
itself records: CI runs, the harness ledger, the known-issues file, the taint
proposal, the campaign ledgers, and the code paths that block or strand a
session.

The short version: **the code is not the bottleneck. The gate is.** LAX has
18,000 unit tests and still ships red, because nothing between "I pushed" and
"a user opened the app" proves the promises in the README. Every phase below
builds that proof first and fixes things second, so fixes stop regressing each
other.

---

## 1. Diagnosis: why it keeps breaking

### 1.1 Main is red, and it ships red

| Check (on `main`, last 24 h) | Result |
|---|---|
| Security & CI, unit tests (ubuntu + windows) | **failing on every push** since `67e3130` |
| Rolling Installer test gate ("blocks publish to the fleet feed") | **failing**, same cause |
| Pre-flight, Semgrep, Rolling Source Asset | passing |

The cause is two threshold assertions in `src/model-tiers.test.ts`: the new
`from_template` action pushed the `presentation` tool's compact description to
278 chars (cap 220) and the medium-tier manifest to 10,034 chars (ceiling
10,000). Windows adds a flaky cross-process lease test. Six more commits landed
on top of the red one. Nobody was blocked, because:

- Commits go straight to `main`. 47 of the last 50 are direct pushes by one
  author; the repository has had four pull requests ever, none merged.
- There is no branch protection and no required check.
- The "every update is validated before it lands" promise is the OTA sandbox
  boot, which is downstream of a feed that the red gate is currently refusing
  to publish to. So the promise is technically kept by shipping nothing.

### 1.2 Sessions get disarmed, and recovery is bolted on per symptom

The repository documents the exact failure the user keeps hitting.
`docs/proposals/taint-scoped-to-data-flow.md`: an inbox read tainted the
session, every later browser write on an unrelated site was denied with
"Run has been quarantined", and the agent degraded to reading steps aloud.
The user's own summary, quoted in the doc: "this basically makes the agent
useless."

Mechanisms that can leave a session degraded or stranded, as they stand today:

| Mechanism | Where | What the user sees | Recovery today |
|---|---|---|---|
| Session taint latch (web/rag/email/sensitive read) | `src/data-lineage/`, `src/tool-execution/enforce-policy.ts` | shell / http / browser writes blocked for the rest of the session | "Declassify & retry" card (which did not render for one block class until `175aba5`); shell got a payload-evidence gate, browser/http only partially (`taint-scope.ts`) |
| Kernel run-rule quarantine | `src/ari-kernel/quarantine.ts`, `src/tool-execution/kernel-block.ts` | writes refused for the rest of the turn | nothing to click; next message starts clean, but two incidents on 2026-09-27/28 told the user to click a button that did nothing |
| Session policy preset / allowed-tools list | `src/session/policy.ts` | "Blocked by session policy" | only via API or settings; not surfaced on the block card |
| Turn lock | `src/session/turn-lock.ts` | second message refused while a turn holds a committing tool call | cancel or wait; in-memory only |
| Op lease / stale op | `src/canonical-loop/lease.ts`, `active-ops.ts` | session appears hung | janitor `recoverStaleOp`; the rollback runbook lists "stuck in running past lease" as a known incident class |
| Pending approval | `src/approval-manager.ts` | card waiting; times out | durable column reconciles after restart |
| Empty / refused / reasoning-only turn | `turn-loop/decide-outcome.ts` | turn ends with nothing | fixed piecemeal in H-024, H-033, `6876f3f`, `c47e061` |
| Everything above lives in process memory | `src/server/lifecycle.ts:185` | a restart clears every quarantine | restart is the real reset button and the UI never says so |

Each row was found live, fixed in place, and recorded in a commit message or
a doc. There is no single model of "session health", no one reset affordance,
and no test that says: *whatever blocked the last call, the next user message
must work.*

### 1.3 Tools: registered is not the same as working

- ~80 tools in the audience map, 47 policy entries, 27 Ari action-map entries.
  `src/tools/tool-reference-coverage.test.ts` proves every referenced name is
  registered (good, added in `d24744c` after `search_past_sessions` was not).
  Nothing proves a registered tool returns a non-error result on a fresh
  install with a real provider.
- The harness ledger (`eval/HARNESS_LEDGER.md`, H-001 to H-034) and the
  failure manifest (`eval/op-outcomes/failure-manifest.md`) are the real bug
  tracker. The pattern is consistent: a tool fails in a way the model cannot
  work around (`select` demanded a CSS selector; `read /tmp` not mapped; a
  template token leaked into an argument key; a dedup stub returned no
  content), the model reports "my tools are broken" and stops, and the fix
  lands weeks later after an eval run surfaces it.
- The eval battery is explicitly non-blocking ("never gates a commit").
  Local-model pass rate on the dev split was 33% (`docs/harness/HARNESS_LOG.md`).

### 1.4 Surface area outruns verification

435k lines of TypeScript across 1,694 source files: chat, voice (three
sidecars), scheduled missions, app builder, auto-build orchestrator, learned
protocols, Telegram, WhatsApp, Android, phone bridge, Agent Sync, plugins,
MCP, presentations/documents/spreadsheets/PDF, Windows/macOS/Linux shell
cages, Electron desktop. The unit suite takes 26 min on Linux and 53 min on
Windows. Every one of those subsystems is a place a user can get stuck, and
most have no end-to-end check at all (the known-issues file lists voice
transport and the lite sidecar as "unverified on hardware").

### 1.5 No queue

There are zero GitHub issues. Failures live in `docs/known-issues.md`, two
ledgers, three campaign files, a proposals directory, and commit bodies. A
plan cannot be executed autonomously against that; it needs one ordered list.

---

## 2. What "production" means here

A build is production when all of the following hold on a **fresh install**,
for each supported provider lane (Anthropic, OpenAI, xAI, Ollama), on
Windows and macOS:

1. **Install and first run** complete without the user touching a terminal.
2. **Ten core journeys** pass end to end against the real server (list in
   §4, Phase 3). These are the README's promises turned into tests.
3. **No session can be bricked.** Every block class has a recovery path the
   UI shows, and the next user message always runs. Proven by a suite, not a
   runbook.
4. **Every tool the model can see works** on that install, or it is not
   registered on that install.
5. **Main is green** on the required checks, and only green commits reach a
   release.

Anything not covered by 1–5 is "experimental", shipped behind a flag that is
off by default and labeled as such in Settings.

---

## 3. Operating model: how to let an agent loose safely

The question was whether a masterplan can be handed over and worked
autonomously. Yes, under these conditions. Without them, autonomous work
reproduces the current pattern (fix, push, red) faster.

**Repository rules (set once, by the owner):**

- Branch protection on `main`: PRs only, required checks = fast lane + full
  lane (§4 Phase 0), no force-push, linear history.
- The agent works on branches, opens PRs, drives them to green, and never
  merges. Merge is the owner's click, or auto-merge once the checks pass and
  the owner has approved the campaign.
- One PR per item on the board. No PR mixes a fix with a feature.
- Stabilization freeze until Phase 3 is green: no new tools, no new channels,
  no new subsystems. Fixes and gates only.

**Environment the agent needs:**

- A cloud environment with provider credentials as secrets (at minimum the
  Anthropic key; the others for the provider matrix) so the agent can run
  the real server and the journey suite, not just vitest.
- Permission to run `npm ci` (native modules) and Chromium there; this
  container has neither `node_modules` nor the installed build today, so the
  agent is currently limited to reading and unit-level reasoning.

**Cadence:**

- A campaign issue per phase listing the chunks in order. The agent takes
  the next unblocked chunk, opens the PR, posts one status comment when it is
  green or blocked, and moves on. The owner reviews in batches.
- Every chunk ends with a test that would have caught the bug. A fix without
  its regression test does not close the item.

**Hard limits on the agent (already in AGENTS.md, restated as gates):** no
file over 400 LOC, no bypass of `src/tool-execution/`, no tool without its
seven registration sites, no secrets in source, no self_edit paths that skip
the kernel.

---

## 4. Phases

### Phase 0 — Stop the bleeding (2–3 days)

Goal: a green `main` that cannot go red silently.

1. **Fix the two `model-tiers` assertions.** The test's own comment names the
   lever: collapse the office families to an `{action, params}` schema for
   medium tier rather than trim descriptions again. If that is too large for
   day one, shorten the `presentation` compact description to the cap and
   move the ceiling to the measured value with the rationale, then file the
   schema collapse as a Phase 2 item.
2. **Quarantine the Windows lease flake** by root-causing it (22 vs 23
   "held" results means one spawn raced the fence), not by skipping it.
3. **Branch protection + required checks.** PRs only.
4. **Split CI into a fast lane and a full lane.** Fast lane under ten
   minutes on every PR: typecheck, source hygiene, docs map, the
   `canonical-loop`, `tool-execution`, `tool-policy`, `ari-kernel`, and
   `tools` test directories. Full lane on merge to `main` and nightly: the
   whole suite on both OSes, desktop tests, replay. Today everything runs on
   every push and takes up to an hour, which is why red is tolerated.
5. **Open the board.** Turn `docs/known-issues.md`, the OPEN rows of
   `eval/HARNESS_LEDGER.md` (H-019, H-020, H-022), the open proposal
   (`taint-scoped-to-data-flow`), and the failure-manifest OPEN rows (G2, P1)
   into GitHub issues with labels `session-health`, `tool-reliability`,
   `gate`, `installer`, `experimental`. Delete the doc entries as they move.

Exit: main green on both lanes; a PR with a failing fast lane cannot merge.

### Phase 1 — Sessions cannot be bricked (1–2 weeks)

Goal: one session-health model, one reset affordance, one suite that proves
the next message always works.

1. **Define `SessionHealth`** as one read-only view that aggregates every row
   in §1.2: taint labels and their sources, kernel quarantine state for the
   live op, session policy preset and allowed-tools, turn-lock holder, lease
   state, pending approvals. Expose it at `GET /api/sessions/:id/health` and
   in the chat header as a single badge ("Restricted: web taint from
   inbox read at 14:02").
2. **One reset.** `POST /api/sessions/:id/reset-safety` clears taint
   registry, session policy overrides, and the turn lock; cancels the live op
   if its lease is expired; broadcasts `settings_changed`. The block card
   always offers it, with the exact reason it is offering it. The "Declassify
   & retry" button becomes one case of it. Keep the security semantics: a
   reset is a user action, audited, never callable by the model.
3. **Finish taint scoped to data flow** for browser and http writes, the way
   shell already has it (`enforce-policy.ts` payload-evidence gate). A `fill`
   whose bytes the user typed, on a host unrelated to the tainted source, is
   not exfiltration. The proposal document has the rule; implement it with
   the kernel's taint-keyed rules still owning the genuine exfil case.
4. **Make kernel quarantine explain itself in one voice.** `kernel-block.ts`
   already chooses recovery text by verdict; extend that so every block
   class (policy, session preset, approval timeout, rate limit, sandbox
   denial, taint, kernel rule) renders the same card shape: what fired, what
   is still allowed, what clears it, and whether the next message starts
   clean.
5. **Stuck-op watchdog in the UI.** When an op passes its lease window, the
   chat shows it and offers cancel. `recoverStaleOp` already exists; the user
   just cannot see it.
6. **The "cannot brick" suite.** For each block class, a test that drives the
   real server (the isolated server in `eval/op-outcomes/isolated.mjs` is the
   right harness) through: trigger the block, assert the card and its
   recovery action, take the action, send the next message, assert it runs a
   tool successfully. This suite is in the fast lane.

Exit: no row in §1.2 lacks a visible recovery; the suite passes on all
providers; a server restart is no longer the hidden reset.

### Phase 2 — Every visible tool works (2–3 weeks)

Goal: "registered" implies "proven on this install".

1. **Tool conformance test**, build-time: every entry in `allTools` has its
   policy entry, audience, Ari action, capability sets, timeout, and the
   session-scope flag if it takes `_sessionId`. `tool-reference-coverage`
   covers names; this covers the seven sites in AGENTS.md. Fails the fast
   lane.
2. **Tool smoke per install**, runtime: a `doctor` pass at boot (there is a
   `doctor-telemetry-health` test, so the seam exists) that calls each core
   tool with a harmless argument and records pass/fail. A tool that fails
   smoke is deregistered for that boot and listed in Settings → Doctor with
   the error. The model never sees a tool that cannot run. This is what turns
   "my tools are broken, I'll stop" into a tool list that is true.
3. **Core tool tier.** Declare the tools the ten journeys need (read, write,
   edit, delete/restore, glob, grep, bash, process_start/status, browser,
   web_fetch, web_search, http_request, memory, remember/recall, setting,
   task_create/update, build_app, app_rebuild, ask_user, protocol) as `core`.
   Everything else is `extended`. Core tools get a real-provider smoke in the
   full lane; extended tools get the conformance test only.
4. **Argument repair owns the whole schema.** H-028 (template tokens in
   argument keys) and H-031 (`select` demanding a selector) are the same bug
   class: the tool contract was narrower than what a model will emit.
   Audit each core tool's schema for required fields a model cannot know,
   and make the element or the file decide (as `select` now does).
5. **Burn down the OPEN ledger rows** that are harness, not model:
   H-019 (timed-out background call keeps the GPU), H-020 (60 s compaction),
   H-022 (recall paging instead of working), G2 (browser extraction after
   navigation), P1 (research cases erroring on OpenAI).

Exit: conformance test green; doctor runs on boot; every core tool passes
smoke on all four provider lanes.

### Phase 3 — The journey gate (2–3 weeks)

Goal: the README's promises as a blocking test.

The ten journeys, drawn from `eval/op-outcomes/cases.json` and the README's
own examples:

| # | Journey | Promise it proves |
|---|---|---|
| 1 | Fresh install, pick provider, first message answered | install + provider auth |
| 2 | "Change the app to dark mode" | runtime-state lane, `setting` tool, broadcast |
| 3 | "Build me a todo app", open it from the sidebar | workspace apps, `build_app`, `/apps/*` |
| 4 | Read a file with a secret, then fill a form on another site | taint scoped to data, Phase 1 |
| 5 | Browser task through a consent wall, correct answer | browser tool, obstruction handling |
| 6 | Research three pages, write a document | web_fetch, sanitize, document tool |
| 7 | Shell task that must act on exit code | bash, process tools |
| 8 | Schedule a mission, see it fire | cron missions |
| 9 | Remember a fact, new session, recall it | memory |
| 10 | Prompt injection in a file and on a page: not executed, task still finishes | kernel, sanitize |

1. Run them against the real server on each provider lane, Claude as the
   control (the failure manifest already uses it that way).
2. Deterministic ones (1, 2, 3, 7, 8, 9) in the full lane, blocking.
3. Non-deterministic ones (4, 5, 6, 10) nightly, N=3, with floors that
   **block the release tag**, not just print a warning. Today
   `baseline.json` says "never gates a commit"; that line is the one to
   change.
4. Fresh-install smoke on Windows and macOS in CI using the existing
   `installer-rolling` lane, extended to launch the app and run journey 1.
   Linux stays a developer target.

Exit: a release tag can only be cut from a commit that passed the journey
gate.

### Phase 4 — Scope and the release train (ongoing)

1. **Decide the 1.0 surface.** Recommended: chat, core tools, workspace apps,
   missions, memory, settings, the three cloud providers plus Ollama, the
   guarded shell cage, push-to-talk voice. Everything else (full-duplex
   voice, Telegram, WhatsApp, Android, phone bridge, Agent Sync, plugins,
   learned protocols, auto-build orchestrator, remote MCP) becomes
   `experimental`: behind a flag, off by default, labeled in Settings, with
   its own test lane that does not block the core gate.
2. **Weekly release train.** Tag from green `main` that passed Phase 3.
   `release:gate` already exists; it becomes the only path to a tag.
3. **Known-issues becomes the issue tracker.** The doc goes away.
4. **Unit suite diet.** 18,000 tests that do not catch the failures users
   hit are cost, not safety. After the journey gate is in, prune tests that
   assert implementation detail with no user-visible invariant, and keep the
   full suite under 15 minutes per OS.

---

## 5. What I can start on today, in this environment

Without provider keys and native modules in the cloud container, the work
available now is Phase 0 items 1, 2, 3 (the PR and the protection rules
need the owner), 5, and the Phase 1 and Phase 2 code that is unit-testable:
`SessionHealth`, the reset endpoint, the unified block card, the tool
conformance test, and the schema audit. Phase 1 item 6 and all of Phase 3
need the running server, which needs the environment in §3.

The first PR is Phase 0 item 1 and 2: green `main`. Nothing else is worth
merging onto a red base.
