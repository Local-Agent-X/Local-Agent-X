# ADR 0007 — Agents that work in parallel see each other's work

Status: Proposed — 2026-11-09 (awaiting the owner's OK before any code)

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

1. **Same-folder clash in an attended chat: ask, or note?** Proposed: ask. A
   note alone lets the second chat overwrite the first's half-finished edit.
2. **Chat idle hold: 30 minutes?**
3. **Merge with overlap: report and merge (proposed), or hold the merge for the
   user's yes?**
4. **Phone in this change, or desktop first and phone after?** The phone needs
   an agentxos contract change and a mobile build.
