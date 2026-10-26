---
name: canonical-check
description: Preflight gate before building or modifying any subsystem — locate the canonical module that already owns this responsibility and force the new work to extend it instead of forking a parallel implementation. Use when the user invokes /canonical-check, or BEFORE starting any non-trivial implementation that touches agent loops, chat streaming, tool dispatch, memory, sessions, providers, sandboxes, or any other shared subsystem. The skill blocks "I'll just make a new file for this" and routes work to the one source of truth. Sibling to /find-duplicate-systems (which audits existing duplication); this one prevents creating new duplication.
user-invocable: true
allowed-tools:
  - read
  - glob
  - grep
  - bash
  - agent_spawn
  - ask_user
---

# /canonical-check — Don't fork a new system; extend the canonical one

The repo has paid the cost of parallel implementations twice already (the agent-loop collapse into `src/canonical-loop/` and the WS-stream collapse into `src/chat-ws/`). The user's rule:

> Every subsystem has one source of truth. New work extends it. No forks, no parallels, no "temporary" second versions.

This skill is the gate that enforces that rule **before** code gets written, not after.

## When this fires

Run this skill (with no prompting from the user) at the start of any task that:

- Introduces a new file under `src/` that owns a subsystem-level responsibility (loop driving, stream emission, tool registration, memory mutation, session persistence, provider IO, sandbox lifecycle, settings resolution, auth resolution).
- Touches a file matching `**/{loop,stream,registry,client,session,memory,sandbox,settings,auth}*.ts` — these are subsystem anchors.
- The user describes the work with words like "new", "another", "separate", "parallel", "lightweight version of", "stripped-down", "my own".
- The user references a subsystem by name ("the chat stream", "the agent loop", "tool dispatch", "memory writes") and is about to modify it.

You can also run on explicit invocation `/canonical-check <description of planned change>`.

## What this skill does

It is a **read-only preflight**. It produces one of three verdicts:

- **EXTEND** — a canonical module exists; the new work must hook into it. Report names the module, the extension point, and what the diff should look like.
- **ADAPTER** — a canonical module exists but for a different transport/surface than the new work. The new work is a legitimate adapter on top of the canonical. Report names the canonical core to call into and the adapter pattern already used by siblings.
- **NEW** — no canonical exists. The new work is genuinely greenfield. Report names what it must become the canonical for, and where it should live so the next person finds it.

You do **not** write code in this skill. You produce the verdict and hand control back. The user (or the agent doing the implementation) then proceeds with the verdict in hand.

## The procedure

### 1. Restate the planned work in one sentence

Before searching, write one sentence: "The work is to <verb> <noun> that <constraint>." If you can't write that sentence, ask the user to clarify in one question and stop.

### 2. Identify the subsystem axis

Map the work to one of the known subsystem axes (the same list `/find-duplicate-systems` uses):

- Agent / tool-call loop
- Chat / message streaming transport
- Tool registry / dispatch
- Memory writer
- Provider client
- Session / conversation state
- Auth / credential resolver
- Sandbox / workspace lifecycle
- Settings / config reader
- WebSocket / IPC server endpoint
- **Other** — if the work doesn't fit any of the above, name a new axis and proceed; new axes are how greenfield work gets a NEW verdict legitimately.

### 3. Locate the canonical

Don't trust memory — memories about file paths go stale. **Verify:**

- `glob` the expected anchor (`src/canonical-loop/`, `src/chat-ws/`, `src/ari-kernel/`, `src/auth/`, `src/session/`, `src/sandbox/`, `src/conversation/`, etc.). The repo has been consolidating into named subsystem directories — that's the pattern.
- `grep` for the responsibility verbs from step 1 (e.g., `"tool call"`, `"ws.send"`, `"memory.append"`, `"registerTool"`) within `src/`.
- Read the top of the most-imported file in the matching directory to confirm it's the canonical entry point, not a sibling helper.
- If multiple candidates surface, that's a duplication smell of its own — surface it and recommend running `/find-duplicate-systems` on that axis before proceeding.

For deep / ambiguous lookups, delegate to a **single** read-only helper agent (`agent_spawn` with the `reviewer` role) with: "Find the canonical module in this repo that owns: <responsibility>. Report path + entry function + top 3 callers. If two modules both look canonical, name both." Don't fan out — this is one targeted lookup, not an audit.

### 4. Decide the verdict

Apply this decision tree:

```
Did you find a module that owns this exact responsibility?
├─ Yes → Does the new work change the responsibility or just add a
│        new caller/transport/option?
│        ├─ Adds caller / option / config        → EXTEND
│        ├─ New transport over same core logic   → ADAPTER
│        └─ Replaces the responsibility entirely → EXTEND (rewrite
│                                                  in place, don't
│                                                  fork)
└─ No  → Is there a near-cousin (same axis, sibling responsibility)?
         ├─ Yes → ADAPTER under the cousin's directory; do not start a
         │        new top-level subsystem
         └─ No  → NEW (and name the canonical home)
```

The default verdict is **EXTEND**. NEW requires evidence that nothing on the axis exists.

### 5. Produce the verdict report

Output (in chat, terse):

```
Canonical-check: <EXTEND | ADAPTER | NEW>

Axis: <axis name>
Canonical: <path:line of the entry function, or "none">
Why this verdict: <one sentence>

What to do:
- <concrete instruction: which function to call, which interface to
  implement, which directory to put new files in>
- <if EXTEND: the specific extension point — a registry, a hook, a
  config table>
- <if ADAPTER: the pattern to follow — point at a sibling adapter
  that already does this for a different transport>
- <if NEW: the path the new subsystem should live at + the rule that
  it becomes the canonical for this axis going forward>

Forbidden:
- <the specific "new parallel file" pattern that would have been the
  default move, named explicitly so it doesn't happen by accident>
```

Keep the report to **~15 lines**. The point is to make the right path obvious, not to write a design doc.

### 6. Hand back

End with: "Proceed with the work above." Do **not** start implementing in this skill. The skill is the gate, not the build.

## Anti-patterns this skill exists to prevent

- **"I'll add a quick second handler just for X"** — that's how `canonical-loop` ended up with siblings. The verdict is EXTEND; add the case to the canonical handler.
- **"This is different enough to deserve its own module"** — almost never true at the subsystem level. Differences are options on the canonical, not new modules.
- **"The canonical is messy; I'll write a clean version next to it"** — that creates two messy modules a month later. Verdict: EXTEND with a refactor in place, or do `/refactor-godfiles` first.
- **Treating shims as canonical** — a re-export barrel is not the canonical; follow the re-exports to the real owner before naming the extension point.
- **Skipping verification because "I remember where it is"** — memory goes stale, files move, paths get consolidated. Always `glob` + `grep` before reporting the verdict.

## Anti-patterns for this skill itself

- Running on trivial one-file edits (typo fixes, copy changes, single function rename). This skill is for **subsystem-level** work. Don't spam the gate on every change.
- Producing a verdict report longer than ~15 lines. The longer the report, the more it reads like a design doc the user can argue with instead of a gate.
- Saying NEW without naming what axis the new subsystem will own going forward. NEW without an axis is just a license to fork later.
- Implementing the change in this skill. The skill ends with the verdict. Implementation is the next step.

## Relationship to other skills

- `/find-duplicate-systems` — **backward-looking**. Audits what duplication already exists. Run when consolidation is the goal.
- `/canonical-check` (this) — **forward-looking**. Prevents new duplication from being created. Run before any subsystem work.
- `/senior-engineer` — the implementation methodology that runs *after* this skill's verdict.
- `/refactor-godfiles` — splits oversized files. If the canonical is over or near its code-line size cap, recommend moving the job that grew into its own module first rather than extending a god file.

## One-liner

> Preflight gate. Before subsystem work: find the canonical, verdict EXTEND / ADAPTER / NEW, name the extension point, hand back.
