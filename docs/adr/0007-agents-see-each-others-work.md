# ADR 0007 — Agents that work in parallel see each other's work

Status: Accepted — 2026-11-09, with the proposed answer to every question
below. Built in the order of question 8; stage 1 (each chat's own model) first.

## Build status

| Stage | What | State |
|---|---|---|
| 1 | Each chat keeps its own model (§8) | Built 2026-11-09 |
| 2 | Claims with op-lease liveness (§1); the check on every write (§2); hand-over notes, the `work_note` tool, the turn-start section for chats and the briefing section for workers (§3); the "working on" strip in the agents panel (§4, desktop); the merge overlap report and `merged` note (§5) | Built 2026-11-09 |
| 2, rest | Files a shell command changes without naming them become claims (a look at the checkout after each completed command, `agency/tree-changes.ts`, not a post-turn sweep). A `finished` note when a worker's run ends. A spawn's declared area (`agent_spawn`'s `touches`), held from the moment the worker starts. The strip in each chat window (§6). The phone's worker cards (§4): `areas` and `clashesWith` on the agentxos workers snapshot, drawn by agentxos-mobile; it reaches phones with the next over-the-air update or build. | Built 2026-11-09 |
| 2, own copy | A chat's own copy of its project (§6, `agency/chat-own-copy.ts`): offered in the chat window's strip when another chat writes the same folder; the user starts it, merges it back or leaves it from there. It starts from the last commit, is refused for a chat that already changed files in the shared folder, and never merges over uncommitted work or into a conflict (the copy is kept). The Preview tab needed nothing: it shows App IDE apps, not a repo project, and a dev server the agent starts runs in its copy. In a shared folder, a file changed while a chat's shell command ran is credited to whoever really wrote it (`Claim.left`), and what changed between a chat's commands is never credited to its next one. | Built 2026-11-09 |
| 2, not built | Declared claims from a fan-out chunk's footprint (chunks in one wave are already disjoint, and what each writes is claimed as it writes). The offer is a button, not a prompt that interrupts: the question of §6 Q5 ("offer, or give one without asking") stays "offer". | By choice |
| 3, first part | The orchestrator role (§7, `agency/orchestrator-role.ts`): one chat per repo, taken and released from the chat window's strip, with the user's model preferences in words. Its prompt each turn (`orchestrator-brief.ts`): who is working, where they overlap, how to delegate, the rules, what is never its call. A model per delegated task (`agent_spawn`'s `model`, `provider/model`). Rule 1 applied by the harness: a chat that starts a turn on a folder another chat is writing is moved to its own copy first, with a note. | Built 2026-11-09 |
| 3, second part | The watch job (`agency/orchestrator-wake.ts`): the app messages the orchestrator, marked as the app's and not the user's, when two live agents start changing the same files, when a merge landed on files another agent changed or is changing, when a worker is paused for making no progress, and when a task it handed out settles. Events are gathered for 20 s, a repo's orchestrator is woken at most once per 2 minutes, the same event once, and never mid-turn. Hand-off to a chat already working in the project (`work_assign`, `session/assigned-turn.ts`): into its running turn or as a turn of its own, carrying the orchestrator's taint and ingestion marks; only the orchestrator may call it and only for a chat holding claims in its project. | Built 2026-11-09 |
| 6, the screen | Tiled chats (`public/js/chat-tiles.js`, rules in `chat-tiles-core.js`, a pane in `chat-tiles-view.js`): two to eight chats side by side on the chat page. The chat on screen stays the one full chat; the others are live views (name, model, state, recent messages, the reply as it is written, a "needs you" mark while an approval waits). Clicking a view opens that chat in its pane's place. One page and one socket: each tiled chat is subscribed, and a turn another window started is read back when it starts and ends. The orchestrator's pane and a pane in the same files as the chat on screen are marked. Remembered per project in the browser. | Built 2026-11-10 |
| 3, not yet | Rules 2 and 3 are instructions in the orchestrator's prompt, not enforced by the harness. A same-folder clash with a chat that already changed files there still goes to the user. A chat that is open on the project but has changed nothing is not yet a hand-off target (it holds no claim to be found by). A wake-up spends a turn on the orchestrator's model; there is no switch to turn them off short of releasing the role. | Open |
| 4 | Collab mode (§9) | Open |

As built, a holder is keyed by the session its tool calls run in (`sessionId`
plus repo), not by `session:<id>` / `op:<id>`; a chat's display name is its
task until something names it; notes are one file per repo per day, kept 14
days, with no 200-note cap.

## Context

LAX runs agents in parallel: sub-agents (`agent_spawn`), fan-out workers, the
auto-build waves (`src/auto-build/loop/parallel-waves.ts`), autopilot, self-edit
and update worktrees, background jobs, and two or more chats the user has open on
the same project. Each spawned run gets a place to work and a write fence
(`src/agency/agent-workspace.ts`, `src/agency/worktree-core.ts`), which stops two
runs writing the same checkout. Nothing tells a run that another one is changing
the same files or the same area.

The clash shows up late, in one of three ways:

1. **At merge.** `mergeWorktree` (`src/agency/worktree-lifecycle.ts`) merges the
   base into the agent branch inside the worktree and fast-forwards the base. A
   textual conflict fails the merge and leaves the branch for the user. A
   *clean* merge of two runs that changed the same function lands silently,
   and the later run's intent can quietly undo the earlier one's.
2. **Two chats in one project folder.** A coding chat works in its project
   folder itself (`setSessionWorkRoot`, `src/workspace/paths.ts`), not in a
   worktree. Two chats bound to the same folder write the same files with no
   fence between them at all. The stale-read guard (`run-sandboxed.ts`,
   `edit-pins-content.ts`) refuses an edit to a file that changed since this
   session read it, so bytes are rarely lost, but the refused agent learns only
   "re-read the file": not that another chat is mid-change, who, or why. It
   re-reads and overwrites.
3. **Never.** Two runs each change half of one feature in different files; both
   merge cleanly; the feature is now inconsistent and nobody was told.

The goal: no agent steps on another's work without knowing, and the user can
see who is doing what.

## What already exists (canonical check)

Verdict: **EXTEND** for every seam but one; the claim store itself is new and
lives in the module that owns parallel agents.

| Need | Owner it extends | How |
|---|---|---|
| Liveness | `src/canonical-loop/lease.ts` | Every run is an op with a heartbeated lease (10 s beat, 60 s expiry). A claim's holder is live while its op's lease is fresh and the op is not terminal. No second heartbeat. |
| "Which paths does this call write" | `writeTargets` in `src/tool-execution/control-file-gate.ts` | Already resolves every non-read `pathArgs` spec plus a shell command's redirect / `cp` / `mv` / `rm` targets (`shellMutationTargets`). Moved to its own `write-targets.ts` and shared, not rewritten. |
| "Do two path sets overlap" | `normPath` / `pathsOverlap` in `src/auto-build/conflict-graph.ts` | Exact match or directory-segment containment, case-folded. Moved to a shared module both read; the auto-build scheduler keeps its behavior. |
| Telling an agent something at the start of its turn | `src/agent-request/completion-carry.ts` (harness rows) | The turn that reads notes saves them as a tagged harness row after the user's message, so the cached prefix stays a pure function of history. |
| Telling a running agent something mid-run | The tool result note (`injection-exposure.ts` pattern) | A note leads the rendered result; the content is never edited. |
| Asking the user | `policyApprovalReason` (`src/tool-execution/ask-user-gates.ts`) → card when attended, inbox when not (`deferred-call.ts`) | One more gate in `askUserGates`. |
| The user's view, desktop | Agents panel (`public/js/chat-agent-feeds*.js`) fed by `workers_snapshot` / `bg_op_*` | Each worker row gains its claim. |
| The user's view, phone | agentxos `workers.ts` contract, vendored in `src/broker-transport/vendor/` | Optional `claim` field added in agentxos, then `check-vendor-sync.mjs --sync`. |
| Merge | `mergeWorktree` | One check before the fast-forward. |
| Inter-agent messages | `src/agency/message-bus.ts` | Not used: in-memory, one handler instance, lost on restart, and a child-process worker cannot see it. |

Not reused: `src/autopilot/lock.ts` and `src/self-edit/global-lock.ts` are
mutual-exclusion locks (one at a time). Claims are the opposite: everyone runs,
everyone is told.

## Decision

### 1. Holders and claims

A **holder** is one agent doing work: a chat session, or a worker op (sub-agent,
fan-out worker, auto-build chunk, autopilot round, self-edit, background job).

```ts
interface WorkHolder {
  holderId: string;          // "session:<id>" or "op:<id>"
  kind: "chat" | "worker";
  displayName: string;       // what the agents panel already calls it
  sessionId: string;         // the conversation that owns it
  opId?: string;             // the live op (worker), or the current turn's op (chat)
  rootOpId?: string;         // fan-out: the job that spawned it, so siblings group
  repoKey: string;           // the repo's git common dir, real-path; one space per repo
  checkout: string;          // the folder it writes: worktree path or project folder
  branch?: string;
  task: string;              // one line: what it is doing
  claims: Claim[];
  lastActiveAt: string;
}

interface Claim {
  path: string;              // repo-relative; a directory claims everything under it
  source: "declared" | "written";
  since: string;
}
```

**Coordination space = the repo, not the folder.** `repoKey` is the git common
dir, so every worktree of one repo and the main checkout share one space. A
project that is not a git repo uses its real-path folder.

**Claims come from two places, and the second does not depend on the model:**

- **Declared** up front: a fan-out chunk's footprint (the `/app-build` plan's
  `footprint`, already parsed), `agent_spawn`'s brief (a new optional `touches`
  argument), and a `work_claim` tool any agent can call to say "I'm about to
  rework `src/voice/`". Declaring is how an agent reserves an *area* before it
  has written anything.
- **Written**: every file a successful write touches becomes a claim
  automatically, recorded after dispatch. An agent that never declares still
  claims exactly what it changed.

**Liveness, by kind:**

- A **worker** holds its claims while its op's lease is fresh and the op is not
  terminal (`isLeaseExpired`, `src/canonical-loop/lease.ts`). A crashed worker
  stops heartbeating; its claims lapse within the lease window (60 s by
  default). When the op ends, claims end; an unmerged branch it left is the
  merge check's concern (§5), read from git, not from claims.
- A **chat** is live while a turn runs, and stays *held, idle* for 30 minutes
  after its last turn. A coding chat between messages is still on its task;
  without the idle hold, two chats taking turns would never see each other.
  After the hold, its claims drop to *recent*: shown, and named in notices,
  but no longer a reason to ask the user.

**Storage.** One file per holder, `<lax data dir>/coordination/holders/<holderId>.json`,
written atomically (`src/util/json-store.ts`) only by the process running that
holder; readers list the directory. One writer per file means no lock and no
lost update between parallel workers, child-process workers included. A file
whose holder is dead (lease expired, or chat past its hold) is swept on read and
at boot.

### 2. Edit-time check

A new gate, `claimClashGate`, in `src/tool-execution/`, run for every call whose
`writeTargets` is non-empty, after the file-access gate (so it never runs for a
call that would be refused anyway). For each target it asks the claim store:
which *other* live holders in this repo claim an overlapping path?

What happens depends on whether the two holders share a checkout:

| Situation | What really collides | Response |
|---|---|---|
| **Different checkouts** (two worktrees, or a worktree and the main folder) | Nothing yet; the clash is at merge | The write runs. A note leads the result: *"`src/voice/stt.ts` is also being changed by **Fix STT latency** (worker, branch `agent/ab12`, since 14:02): 'swap Whisper base for trim'. Its latest note: … Your change will merge after or before theirs; keep the edit compatible, or post a note with `work_note`."* Once per (other holder, claimed path) per turn, not on every write. |
| **Same checkout** (two chats in one project folder; a worker given the folder itself) | The other agent's working files, now | Attended: the user is asked, through `policyApprovalReason`, naming the other chat, its task and the file. Approve covers that (other holder, path) for the rest of this turn. Unattended: parked in the inbox, never refused silently. |
| Other holder is only *recent* (chat past its idle hold, or a finished worker whose branch is unmerged) | Possibly nothing | The note only, never a question. |

A **declared** claim on a directory counts the same as a written one: an
agent that said "I'm reworking `src/voice/`" is named to anyone writing under
it. Nothing is ever refused by a claim alone; the most a claim does is ask the
user, who may say yes.

Limits, said plainly: shell writes are seen only as far as
`shellMutationTargets` sees them (redirects, `cp`, `mv`, `rm`, …); `sed -i`,
a code generator or a build step writing files is not seen at call time. Those
writes are caught after the fact: a post-turn `git status` of the holder's
checkout adds the changed files as *written* claims, so the next writer is told
even if this one wasn't checked.

### 3. Hand-over notes

A short feed per repo: `<lax data dir>/coordination/notes/<repoKey-hash>.jsonl`,
appended with `updateDurableJsonl` (`src/persistence/durable-jsonl.ts`), capped
at the last 200 notes or 14 days.

```ts
interface HandoverNote {
  id: string; at: string;
  holderId: string; displayName: string;
  paths: string[];           // what it is about
  text: string;              // "changed X, here's why" — 600 chars max
  kind: "agent" | "merged" | "finished";
}
```

Written three ways: the agent's `work_note` tool; automatically when a branch
merges (`merged`: the files, the branch, the holder's task); automatically when a
worker finishes with unmerged or merged changes (`finished`: its summary).

Read three ways:

- **At turn start**: notes since this holder last read, from other holders in
  the same repo, ranked by overlap with this holder's claims, at most 8 notes /
  ~1,200 tokens, plus one line per live holder in the repo ("**Fix STT
  latency** — worker — `src/voice/`"). Saved as a tagged harness row after the
  user's message, the way `completion-carry.ts` saves finished background work,
  so the system prompt and the cached prefix do not change between turns.
- **Mid-run, at a clash**: the clashing holder's latest note rides in the
  edit-time note (§2). A worker running for an hour sees what changed under it
  at the moment it matters.
- **By the user**: on the agent's card (§4).

### 4. The user's view

**Desktop.** The agents panel (`public/js/chat-agent-feeds*.js`) already lists
every worker. Each row gains: its task line, the areas it claims (collapsed to
the top directories, "+3 more"), and a clash badge when another live holder
overlaps it, naming that holder. Chats get a row too while held: a coding chat
in the same project is exactly the "other agent" the user forgets about. Notes
show in the row's detail. Updates ride a new `work_claims_changed` frame on
`broadcastAll`, and a snapshot is sent with `workers_snapshot` so a tab that
connects late is current.

**Phone.** The worker list on the phone reads the agentxos `workers.ts` contract.
`WorkerSnapshot` and `bg_op_started` gain an optional `claim: { task, areas,
clashesWith? }`, changed in agentxos first and synced (`scripts/check-vendor-sync.mjs
--sync`), then drawn in agentxos-mobile's worker list. Optional, so an older phone
build simply does not show it.

### 5. Merge time

In `mergeWorktree`, after the base is merged into the agent branch inside the
worktree and before the fast-forward:

1. **Both sides changed it.** Files changed on this branch since its fork point
   *and* on the base since that point (git merged them cleanly). For each,
   name who changed the base side, from the `merged` notes; a commit that no
   note covers is "someone outside LAX".
2. **Live overlap.** Files this branch changed that another live holder claims,
   or that another unmerged agent branch in this repo also changed
   (`git diff --name-only base...<their branch>`).

Neither blocks a merge that git can do. The result carries the list
(`mergeWorktree` returns `overlaps`), the completion the user reads names it, a
`merged` note goes to the feed so the other holder learns at its next turn or
next clash, and the agents panel badges both. The existing refusal to
fast-forward over uncommitted edits in the user's checkout stays as it is.

### 6. Many chats on one screen

The working mode this is for: several chat windows open side by side, each
agent on a different task in the same project, each able to see the others.

**A second coding chat on a folder another live chat holds gets its own
worktree.** Two chats writing one folder can only be made safe by asking the
user at every shared file; with six chats that is a card storm. So when a coding
chat binds to a project folder (`setSessionWorkRoot`) that another live chat in
the same repo already holds, LAX offers, once, to give it a worktree of that
repo on its own branch, merged back through `mergeWorktree` when the user says
the work is done (or on "merge" in that chat). The first chat keeps the folder
itself. Declined, the chat shares the folder and the same-checkout row of §2
applies. With worktrees, the edit-time check is a note, never a question, and
the only shared moment is the merge (§5).

**Every chat sees the others.** Besides the turn-start line and notes (§3), each
chat window shows a one-line strip under its header listing the other live
holders in the same repo (name, task, a clash dot when it overlaps this chat's
claims), fed by the same `work_claims_changed` frame as the panel.

**The screen itself.** The chat page tiles two to eight chats (the Tiles button
in the chat toolbar). One pane is the chat on screen, whole; the rest are live
views that a click turns into the chat on screen, in place. A live view is text
only: cards, approvals and rendered markdown are in the full chat, one click
away. The browser panel, terminal and voice follow the chat on screen.

Tiles belong to the Lab, the name on screen for the sidebar's code side since
2026-11-10 (the session mode is still `code`; only the label changed). Panes
are useful when they share something, and Lab sessions share a project folder;
ordinary chats share nothing, so the button is not offered on one, only Lab
sessions can be panes, and opening an ordinary chat puts the grid away until
the next Lab session is opened. Collab (§9) is the second way into tiles, where
the panes share a problem instead of a folder.

**How many at once.** What bounds it today, from the code:

| Limit | Value | Where | What happens past it |
|---|---|---|---|
| Chats running a turn at the same moment | 10 | `maxInteractiveSessions` (`src/config-schema.ts`), the scheduler's `interactive` lane | The 11th waits in the queue |
| Sub-agents across all chats | 5 | `maxSubAgents`, the `agent` lane | Queued; six chats each spawning workers share five slots |
| Everything in flight | 12 | `maxConcurrentAgents`, the global ceiling | Queued |
| Local model (Ollama) | 1 | `resourceLocksForProvider` → `gpu:0` (`src/ops/provider-matrix.ts`) | Local-model chats run one at a time |

Six chats on hosted models fit inside every limit. What runs out first is
outside LAX's code: the subscription's usage window (six agents spend it about
six times as fast) and the machine, when several agents run the full build or
test suite at once. Neither breaks anything, but both slow everyone. The
coordination layer adds a heads-up when two agents start the same heavy command
(`npm run build`, the full test suite) in one repo within a minute, in the same
edit-time note.

Those caps count agents *working at the same instant*, not windows open: a chat
waiting for the user's next message holds no slot. The hard ceiling today is
the global 12 (`maxConcurrentAgents` is clamped to 12 because
`MAX_CONCURRENT_WORKTREES` in `src/agency/worktree-core.ts` is 12); the chat
cap is settable up to 20 but the global ceiling wins. Raising past 12 is a code
change to both, and only worth it once usage limits allow it.

### 7. A lead agent answers coordination questions instead of the user

With six agents, the questions of §2, §5 and §6 (share this file? take a
worktree? merge despite overlap?) would reach the user many times an hour. A
**lead** answers them instead.

The lead is not a new kind of agent. Two owners already do half of it:

- **The project roster's manager** (`src/project-rosters.ts`,
  `src/agents/escalation-core.ts`): agents escalate `to: "manager"`, the stall
  watchdog wakes the manager, and escalates past it to the user at twice the
  threshold.
- **The app-build orchestrator** (`src/auto-build/`): splits a goal into chunks
  with file footprints, schedules them into non-overlapping waves
  (`planWaves`, `conflict-graph.ts`), runs them in worktrees and merges them in
  order.

The lead is the roster manager role given to one agent per repo, with three
jobs:

1. **Answer coordination questions.** When a lead is live in the repo, the §2
   same-checkout question, the §6 worktree offer and a §5 overlap go to the lead
   through the escalation path, not to the user. It decides by written rules,
   in this order: never let two agents write one checkout (move the later one
   to a worktree); when two branches overlap, merge the smaller first and tell
   the other to rebase onto it; when two agents claim one area for different
   goals, pause the later one and post a note to both. It posts every decision
   as a hand-over note, so the user can read why.
2. **Delegate.** Given a goal ("ship phone alerts and fix the STT latency"), it
   splits it into tasks with declared areas, schedules them with `planWaves` so
   no two running tasks claim the same area, and starts each as a worker, each
   one a row in the agents panel that can be opened as its own chat window.
   It can also hand a task to a chat the user already has open, by sending that
   chat a message (the inject queue, `src/agent-loop/inject-queue.ts`), shown in
   that chat as coming from the lead.
3. **Watch.** It reads the claim store, the notes and the workers' progress;
   when a worker stalls or two drift into one area it steps in by the same
   rules.

**What the lead never decides.** A coordination question is about who works
where and in what order. Everything the app asks the user today for safety
stays the user's: tool approval cards, a write to a control file, a secret's
first use at a new destination, anything parked in the inbox by
`deferred-call.ts`. The lead cannot approve those for a worker, and an agent
cannot escalate one to the lead to get around the user. Product, money,
security and taste questions from workers also go past the lead to the user's
inbox, the way the stall watchdog already escalates past a manager.

Without a lead in the repo, coordination questions come to the user as §2–§6
describe.

In the UI and from here on the lead is called the **orchestrator**.

### 8. Each chat keeps its own model

Today the model picker is global: `laxSwitchModel` (`public/js/chat-status-bar.js`)
posts `/api/providers/switch` (`src/routes/settings/providers.ts`), which saves
`provider` / `model` to settings and broadcasts `settings_changed` to every tab.
Switching one chat to Grok switches all six.

The per-turn plumbing for a per-chat model already exists: `providerOverride` /
`modelOverride` on the request (`src/agent-request/types.ts`), resolved by
`resolve-provider.ts` and kept as the op's `targetPin` (`target-pin.ts`).
Spawned agents already carry their own `AgentModelPin`. What is missing is a
place to keep the choice per chat:

- The session records a **model pin** (`provider`, `model`, `effort`) in its
  metadata. Picking a model in a chat sets that chat's pin and broadcasts it for
  that session only; other chats are untouched.
- Every turn of that chat sends its pin as the override. A chat with no pin uses
  the global default, which is now "the model new chats start with", set in
  Settings.
- A pin is never silently replaced: if the pinned provider is unavailable the
  turn says so and asks, as the no-auto-fallback rule already requires.
- Each chat window's header, the window strip (§6) and the agents panel show
  the model each agent runs on.

**The orchestrator picks models too.** The orchestrator has its own pin (the
chat the user made the orchestrator keeps its model). When it delegates, each
task can name a model: the user's standing preferences ("Codex for UI, Claude
for the server, Grok for research"), saved as the orchestrator's routing table,
or a per-task choice by the user. A worker started with a model keeps it for its
whole run (`AgentModelPin`); a chat the orchestrator hands a task to keeps its
own.

### 9. Collab mode: models from different companies on one problem

A collab is a group of agents on **one** problem, each on a different provider
(for example Claude, GPT through Codex, Grok), run by the orchestrator. Three
shapes, chosen per collab:

| Shape | What happens | Fits |
|---|---|---|
| **Split** | The orchestrator splits the work; each model takes the parts it is assigned, in its own worktree. §1–§5 keep them out of each other's files. | Building a feature with several parts |
| **Compete** | Every model solves the same task independently in its own worktree; each then reviews the others' work blind (it does not see whose it is); the orchestrator picks one, or merges the best parts, and says why. | A hard bug, a design choice, a risky change |
| **Discuss** | No code: each model answers, reads the others' answers, and revises, for a fixed number of rounds; the orchestrator writes the result with the points they agreed and disagreed on. | A plan, a diagnosis, a question with no single right answer |

**How one starts.** From any chat, which becomes the collab's orchestrator:
`/collab <the problem>`, a Collab button beside the model picker, or asking in
words ("have Claude, GPT and Grok each take a crack at this"). A short card
then shows, already filled in and editable: the members (default: one model
from each provider the user is signed in to, the chat's own model among them),
the shape, the number of rounds, and the cost. The shape is proposed from the
request and the session: a code session with a bug or a risky change proposes
**compete**; a feature with several parts proposes **split**; a question, a
plan or research proposes **discuss**. Nothing runs until the user presses
Start. The two uses it is built for first are coding (compete and split) and
research (discuss, where each member searches on its own and the others check
its sources).

Rules a collab keeps:

- The models' answers reach each other as hand-over notes (§3), marked with the
  model that wrote them, so each sees who said what.
- A model reading another model's output reads it as another agent's work, not
  as instructions: the same untrusted-content rule as any tool result.
- Each member keeps its pin for the whole collab; a provider that fails is
  reported and dropped from the collab, never swapped for another.
- Cost is shown before it starts (members × rounds) and the running token
  total per member is on each row of the agents panel, as for any worker.
- The user sees the collab as one group in the agents panel, one row per model,
  and can open any member as a chat window.

### Module

`src/agency/` owns parallel agents and their isolation; coordination joins it:
`work-claims.ts` (the holder store and liveness), `handover-notes.ts`,
`merge-overlap.ts`. The gate is `src/tool-execution/claim-clash-gate.ts`, since
every model-initiated call's gates live there. The tools (`work_claim`,
`work_note`) are registered in the agents plugin with policy rows in
`tool-policies.orchestration.ts`. ARCHITECTURE.md's "Multi-agent spawn +
isolation" row gains these, and `src/agency/` gets an `AGENTS.md` naming them.

## Consequences

- An agent writing a file another live agent is changing is told who, what and
  why, every time; in a shared folder the user is asked. No claim ever silently
  blocks.
- Two chats on one project see each other: at turn start (the live-holder line
  and notes), at the edit (the note or the question), and in the panel.
- A merge that git does cleanly but that overlaps another agent's work is
  reported, not hidden.
- Crashed agents release their claims within a lease window; chats within the
  idle hold.
- Cost: one directory listing and a few small JSON reads per write call (cached
  for a second per process), one file write per holder per new claim.

## Not covered

- **Claude Code sessions working on the LAX repo** are not LAX holders. The
  files are plain JSON on purpose: a Claude Code hook could read and write the
  same store later. Not part of this change.
- **Semantic conflicts in files nobody shares** (a type changed in one file, its
  caller in another) are not detected. `npm run refs -- <Name> --depth N` is the
  tool for that and a later step could run it at merge.
- **Writes a shell command hides** are seen at the end of the turn, not before.

## Questions for the owner

Answered 2026-11-09: the proposed answer to each.

1. **Same-folder clash in an attended chat: ask, or note?** Proposed: ask. A
   note alone lets the second chat overwrite the first's half-finished edit.
2. **Chat idle hold: 30 minutes?**
3. **Merge with overlap: report and merge (proposed), or hold the merge for the
   user's yes?**
4. **Phone in this change, or desktop first and phone after?** The phone needs
   an agentxos contract change and a mobile build.
5. **A second chat on a held folder: offer a worktree (proposed), or give it
   one without asking?**
6. **The orchestrator: one chat the user marks as orchestrator (proposed), or
   one started automatically whenever three or more agents work in a repo?**
7. **Picking a model in a chat: change only that chat (proposed), with Settings
   holding the default for new chats?**
8. **Build order:** proposed per-chat models first (small, useful on its own),
   then claims, notes and the edit-time check, then the orchestrator, then
   collab. Phone and merge reporting ride along with the stage they belong to.
