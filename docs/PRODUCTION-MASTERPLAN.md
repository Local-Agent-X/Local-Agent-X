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

## 5. Agent modes: one switch in the composer, not nine in Settings

Added 2026-10-01 from the owner's request: replace the composer's Plan chip
with a mode picker like a coding agent's permission picker, where the top
mode means the user is never blocked, and the other modes tighten security
in named steps.

### 5.1 Why users get blocked on the "Autonomous" profile today

Ten independent gates can deny or hold a call, and the autonomy profile is
only one of them. Picking `Autonomous` in Settings leaves the other nine where
they were:

| Gate | Where | Scope | Controlled by |
|---|---|---|---|
| Autonomy profile (ask/allow per risk class) | `src/autonomy/profiles.ts` | global | Settings → Autonomy |
| Safety toggles: shell, http, browser, computer control, supervised browser | `src/settings-schema.ts` | global | Settings → Security |
| File access mode (workspace / common / unrestricted) | `public/js/settings-file-access.js` | global | Settings → File access |
| Web access policy (any public site on a fresh install since `6f995db`; strict allowlist when chosen) | `src/security/layer/egress-policy-state.ts` | global | Settings, or the "Allow host" card |
| Private content leaving for a new destination (email bodies, the user's own documents) | `src/tool-execution/private-content-gate.ts` (`227de1c`) | per session | approval card in an attended run; refused in an unattended run; nothing else reaches it |
| Session policy preset (default / high-security / dev-mode / read-only) | `src/session/policy.ts`, `src/routes/security.ts` | per session | API only |
| Plan mode (read-only turn) | `src/chat-ws/message-router.ts`, `plan-mode-chip` | per session | composer chip |
| Session taint latch + kernel run rules | `src/tool-execution/enforce-policy.ts`, `src/ari-kernel/` | per session / per turn | nothing: no profile or setting reaches the kernel |
| Shell cage (guarded / host / docker) | `LAX_SANDBOX`, Settings | global | Settings |
| `developer_mode` for `self_edit` | `src/settings-schema.ts` | global | Settings |

The kernel row is the one that matters. The Phase 0 audit recorded it
plainly: "today no kernel or tool policy varies by model" and nothing in the
profile table is consulted by the taint or run rules. So a user on
`Autonomous`, with every toggle on, still gets "Run has been quarantined"
after an inbox read. A mode picker whose top mode does not reach the kernel
would be a lie.

### 5.2 The design

**One per-session value, `agentMode`, is the source of truth.** Picking a
mode in the composer sets it over the chat socket (the same path
`plan_mode` uses today), the server derives every gate above from it for
that session, and broadcasts `settings_changed`. Global Settings keep their
fields, but each becomes the *default mode for new sessions* rather than a
separate switch the user has to find. A mode is per session so two chats
can run at different trust levels without one changing the other.

**Modes, top to bottom** (hotkeys 1–5, like the picker in the screenshot):

| # | Mode | What it means | Gates it sets |
|---|---|---|---|
| 1 | **Autopilot** | Nothing is denied. The agent does the whole job and tells you what it did. | profile Autonomous; all safety toggles on; file access unrestricted; web access open; session preset dev-mode; plan off; taint and run rules downgraded from *deny* to *audit* (logged, never blocking); the private-content card follows the 5.3 choice, and an unattended run takes the log path instead of being refused; shell cage stays guarded (it protects credentials from the shell, not the user from the agent, and costs the user nothing) |
| 2 | **Copilot** | Works freely on this machine; asks once before anything leaves it. | profile Power; toggles on; file access common; web access open; the only prompts are money, secrets, private content going to a destination the user did not name, and a red publish review |
| 3 | **Chaperone** | Asks before any change. Reads, searches, and browses on its own. | profile Safe; `toolApproval` confirm-risky; file access common; strict web access with the allow-host card; the private-content card as in Copilot |
| 4 | **Plan** | Read-only. Proposes a plan and stops. | existing plan mode plus session preset read-only |
| 5 | **Locked** | Untrusted work: workspace only, no shell, no outbound writes. | session preset high-security; shell/http/computer off; file access workspace; strict web |

The default for a fresh install is **Copilot**. The owner's ask is that
Autopilot be the everyday mode for a trusted user; that is one click and
remembered per session, and Settings can set it as the default.

**Name options for the top mode,** since "bypass" and "shadow" read as
hostile: Autopilot (recommended: everyone knows what it means and it says
hands-off, not reckless), Free Agent, Full Trust, Unleashed, Open Agent.
The recommendation is Autopilot / Copilot for the top two, because the pair
explains itself.

### 5.3 Secrets leaving the machine: the user chooses

In Autopilot, one case remains where "never blocked" and "never
exfiltrated" pull apart: actual secret bytes the agent read this session
(a key from a file or an inbox) are about to leave the machine in an
outbound payload. That is the only thing the kernel's taint rules exist
for. Both behaviours have a place, so the user picks, per session, and the
pick is remembered:

- **Notify me** (default). Autopilot never *denies*, but this one case
  shows a notice card with the payload evidence and a "Send anyway" button.
  "Always for this session" silences it. Everything else in Autopilot stays
  silent, and the session is clean afterward: no latch, no quarantine.
- **Just log it.** Autopilot never stops. The send is logged with the
  evidence and shown in the chat after the fact. The user accepted this by
  choosing it.

The same choice governs private content (an email body or a personal document
the agent read, sent to a destination the user did not name; `227de1c`). It
is a lower stake than a secret, so it never gets its own control: in
Autopilot it rides this switch, and in an unattended Autopilot run it always
takes the log path, because no one is there to answer a card. Today, before
`agentMode` exists, that gate asks in every attended run and refuses in every
unattended one.

**Where the choice lives: inside Autopilot, not as a sixth mode.** Two
modes whose only difference is one rare card would be indistinguishable in
a picker, and users would pick the wrong one for the wrong reason. The
picker stays at five entries. When Autopilot is selected, one line appears
under it: *Secrets leaving the machine: Notify me / Just log it*. Settings →
Autonomy carries the same control as the default for new sessions. The
implementation is one boolean on the session, read by the payload-evidence
gate in `enforce-policy.ts`; both paths share the same evidence, the same
audit record, and the same post-send state.

If the owner later prefers the two-mode shape, the name for the silent one
should say what it does rather than sound covert: "Autopilot, silent" or
"Autopilot (log only)", never a name that implies stealth.

### 5.4 Where it lands in the phases

This is Phase 1 work, because it is the same job as the reset and the
session-health view: one model of what is allowed in this session, derived
from one value, shown in one place. Chunks, in order:

1. `agentMode` on the session with the derivation table above, replacing
   the direct reads of profile, toggles, file access, web access, preset,
   and plan flag in `src/tool-execution/` and `src/tool-policy/` with one
   resolver (`src/session/agent-mode.ts`).
2. Kernel downgrade: in Autopilot the taint-keyed rules and run rules return
   an audit verdict instead of a deny. This is the piece the current
   profiles never did.
3. The composer chip and popover, replacing `plan-mode-chip`, with the
   hotkeys and the mode badge in the chat header (the same badge that shows
   session health).
4. Settings → Autonomy, Security and File access become "default mode for
   new sessions" plus an "Advanced" expander that still exposes the raw
   fields.
5. The "cannot brick" suite (Phase 1 item 6) runs once per mode.

## 6. What I can start on today, in this environment

Without provider keys and native modules in the cloud container, the work
available now is Phase 0 items 1, 2, 3 (the PR and the protection rules
need the owner), 5, and the Phase 1 and Phase 2 code that is unit-testable:
`SessionHealth`, the reset endpoint, the unified block card, the tool
conformance test, and the schema audit. Phase 1 item 6 and all of Phase 3
need the running server, which needs the environment in §3.

The first PR is Phase 0 item 1 and 2: green `main`. Nothing else is worth
merging onto a red base.

---

## 7. Progress log

One line per closed item, newest first, with the commit that closed it.

- **2026-10-01, Phase 0 item 3, first half: branch protection is on for
  `main`.** Required checks: `Unit tests (ubuntu-latest)` and `Audit + clean
  build` (type-check plus full build). Force-pushes and deletion of `main` are
  blocked. `enforce_admins` is off, so direct pushes from the owner's machines
  and sessions still land, reported as bypassed; requiring PRs of everyone is
  the second half, after the fast lane (item 4). `Unit tests (windows-latest)`
  is deliberately not required yet: it still times out on the remaining flake
  class (`src/update-rollback.test.ts` at `db6625b2`, `src/ota-update.test.ts`
  at `7255126c`). Not done: items 4 (lanes) and 5 (issue board).
- **2026-10-02, the Windows shell cage is live-verified on a fresh install**
  (rolling installer at `b5f376ee`: Settings reads guarded confined, `whoami`
  returns the sandbox account), and shells no longer run unconfined while its
  proof is pending (`df8be7d6`; measured before the fix: a command in that
  window ran as the user's own account).

- **2026-10-01, correction: main did not stay green after `7a0d1ca`.** Four
  of the next ten pushes went red on `Unit tests (windows-latest)`, each on a
  different test hitting a fixed deadline: dev-server crash detection, the
  glob-tool afterAll, the container handoff, rolling-source extraction and
  the global-cap sampler (the last two on one docs-only push). The runner has
  four vCPUs, so vitest runs one file at a time; synchronous file I/O and
  process spawns cost 10-50x Ubuntu there, with 1.5-3 s stalls. Each was
  root-caused, adversarially reviewed and fixed without raising a timeout:
  `687dd3d4` + `53e4f404` (product: a claim written during a stall was read
  as a handoff timeout and the container torn down), `980dc7f3` (product: the
  scheduler snapshot omitted ops holding a reserved slot), `44fae266`
  (product: a synchronous PowerShell port probe blocked the event loop for up
  to 5 s and delayed crash reports), `4ceea91c`, `4177d304`, `e8b4078a`
  (tests doing work their property did not need). A sweep found the rest of
  the class, led by 16 files that run sub-second leases against a 30 s
  production floor, plus a product bug in the op-store lock (a contended
  mutation is skipped or runs unlocked after 500 ms); both are filed as
  follow-ups. Without a required check, a red push still lands silently,
  which is Phase 0 items 3 and 4.

- **2026-10-01, the macOS cage is verified on a Mac.** `09ef9f77`, `97f7bef5`,
  `08e6bc00` and `74aa6c8c` passed live at `91d2a9bf` with a launchd
  `SSH_AUTH_SOCK`: seatbelt + guarded-egress contract 38 passed, every live
  macOS block ran (the 4 skips are 2 Linux-only cases and 2 off-Mac
  passthrough cases), including "DENIES the real ssh-agent socket" and "DENIES
  the resolver daemon's socket". The app's own `bash` tool was also driven
  under the guarded cage end to end (2026-10-01): ssh-agent and `~/.lax`
  refused, direct off-box refused, example.com and scanprogress.com reached
  through the proxy, a sibling port in the proxy range refused.

- **2026-10-01, Phase 1 item 3 (first pass): one adjudicator for data flow.**
  An audit found 12 places a taint label, not the bytes, could deny a call.
  The root: the kernel re-derived data flow from run history (it merged the
  run's labels into every later call and ran sequence rules such as
  `sensitive_read_then_egress`) after LAX had cleared the call on its bytes.
  The kernel now takes `RunStatePolicy.hostAdjudicatesDataFlow` (default off,
  on in LAX); LAX clears every egress tool through one predicate
  (`outboundIsTaintFree`), with an http request's URL now scanned as payload;
  the dead foreign-taint rescue in `ari-kernel/evaluate.ts` is gone. A browser
  `evaluate` script is now scanned too (`873b487`, a hole the audit found).
  Proof: `outbound-taint-sequence.test.ts` runs ten calls in one run through
  the real kernel and fails with the old behaviour. Taint entries are now
  fingerprinted over their whole content (up to 64 KB, as web ingestion
  already was), so a large file's tail is caught on evidence and an unrelated
  payload after it clears. Kept on purpose: payloads under the 24-character
  evidence window are still refused while the session carries content the
  model saw (a short value cannot be proven absent, and sub-window chunks are
  how a secret would be dripped out); after the read stub, sessions rarely
  carry such content. The approval prompt when external content would be
  promoted into long-term memory stays: it guards memory, not egress.
- **2026-10-01: fresh installs allow any public site** (`6f995db`), decided by
  the owner; the threat model states the limit for untracked private content.
- **2026-10-01: private content asks before it leaves.** Email bodies and
  documents from the user's own folders are fingerprinted on read (a separate
  per-session store, `src/data-lineage/private-content.ts`); a send carrying
  their bytes to a destination the user did not choose gets an approval card
  (`src/tool-execution/private-content-gate.ts`), and an unattended run is
  refused. Own address, trusted destinations, destinations the user typed, and
  the correspondents of the one opened email pass silently. Open: logged-in
  browser pages are not tagged private.

- **2026-10-01, Phase 0 item 2: the Windows lease flake, root-caused.** The
  24-process race in `test/lease-cross-process.test.ts` queues 23 losers
  through the op's file lock behind the winner; measured on a developer box
  the slowest waits up to 359 ms against the lock's 500 ms budget, and a
  slower CI disk pushed one past it, so it reported `lock_unavailable`
  instead of `held` (22 held, not 23, on `dc5b2c4`'s Windows lane). The
  lock is a write lock and `held` is a read of state only the holder
  writes, so a caller that waited out the lock now reads the persisted row
  and answers `held` when a fresh lease exists; `lock_unavailable` remains
  for the case the row cannot answer (an expired lease, which only the lock
  holder may take over). Regression tests in `test/loop-lease.test.ts`.
- **2026-10-01, Phase 0 item 1: `model-tiers` green** (`7a0d1ca`). Took the
  short route the plan allows: the presentation compact description is back
  under the 220-char cap and the medium manifest under its ceiling, with no
  ceiling raised. The `{action, params}` schema collapse for office families
  is still the lever and moves to Phase 2.
- **2026-10-01, main green on every workflow** at `7a0d1ca` (true for that
  commit only; see the correction above): Security & CI
  on both OSes (unit, build, integration, Windows cage escape matrix),
  Pre-flight, Semgrep, Rolling Source Asset, and the Rolling Installer with
  its test gate, which then published the first Windows installer carrying
  the signed cage helper. The macOS notarization failure that morning was
  Apple's updated developer agreement (HTTP 403), accepted by the owner.
