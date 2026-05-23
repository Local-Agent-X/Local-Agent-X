---
name: brownfield
description: Land non-trivial changes into an existing codebase without breaking it or fragmenting the architecture. Use when integrating a report's recommendations, refactoring across the codebase, or implementing a feature that touches multiple existing systems. Plans chunks, dispatches each to a fresh sub-agent via the Agent tool, verifies between chunks, pauses on failure. The user never pastes a prompt — orchestration is autonomous through the happy path; failures surface to the user with a diff.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - TodoWrite
  - AskUserQuestion
---

# /brownfield — Land changes into an existing codebase without fragmenting it

Arguments passed: `$ARGUMENTS` (the task — a feature, a report excerpt, a refactor goal).

The greenfield skill assumes a clean slate. This one assumes the opposite: code exists, decisions are already made, conventions are already chosen, and every change can break something downstream. The discipline that matters here is **integration**, not design.

You are the orchestrator. You plan chunks, dispatch each to a fresh sub-agent via the `Agent` tool, verify the result, and either continue or pause. The user only sees the plan once (to approve) and the failures (to decide). The happy path is hands-off.

---

## Mental model

A brownfield skill isn't slower than greenfield; it's stricter. Three rules that flow from "the code already exists":

1. **The seam already exists.** Your job is to find it, not invent one. A new file or a new route is almost always wrong — there's an existing place this work belongs.
2. **The spec is law, but the spec is grounded in the existing code.** Don't write the spec abstractly and then force-fit it. Read the code first; write the spec to fit the seam.
3. **Every change is a candidate for divergence.** Parallel implementations, "v2" files, near-duplicate functions — these are how brownfield codebases die. Refuse to create them.

Optimize for: **the smallest set of edits that integrate cleanly with what's already there, in a form the next maintainer reads without needing to know which "version" they're looking at.**

---

## The loop

### 1. Restate the task in one sentence

Before reading any file, write a one-line restatement. What user-visible behavior changes? What existing behavior must keep working? What's explicitly out of scope?

If the input is a report excerpt, the restatement compresses it — the report's recommendations are *hypotheses*, not requirements. They were written without seeing this code. Half of them may not survive translation.

### 2. Read before you plan

Walk the relevant files. For each area the task touches:
- Read the canonical file (the one that owns the responsibility today)
- Read its callers (`Grep` for imports + usage)
- Read the adjacent module if the change crosses a boundary
- Look for an `AGENTS.md`, `CLAUDE.md`, or top-of-file convention

Identify the **seam**: the existing function, registry, route, or hook where this change belongs. If you can't find a seam, that's the most important finding — either the code has a gap (intentional design space) or you're proposing the wrong shape.

If after 5–10 file reads you still can't locate the seam, **stop and ask** the user where it lives. Don't invent one.

### 3. Plan chunks against the existing structure

Each chunk is:
- **Atomic** — one responsibility, one merge-point
- **Seam-anchored** — names the existing file/function/seam it modifies
- **Verifiable** — has explicit success criteria (tsc passes; test X is green; grep finds Y)
- **Reversible** — can be undone independently of the chunks before/after it

A good chunk plan reads like:
```
1. Extend src/foo.ts:registerHook() to accept a `priority` field
   - Seam: existing registerHook
   - Verify: tsc clean, existing call sites still typecheck unchanged
2. Wire src/bar.ts to pass priority=10 to registerHook for the new path
   - Seam: existing call site at bar.ts:42
   - Verify: tsc clean, bar.test.ts:"orders correctly" green
3. Add a test for priority ordering in test/foo.test.ts (existing file)
   - Seam: existing test file
   - Verify: new test passes, all existing tests still pass
```

A **bad** chunk plan reads like:
```
1. Create new src/priority-engine.ts
2. Create new src/priority-engine.test.ts
3. Wire foo and bar through priority-engine
```
That's greenfield thinking inside a brownfield codebase. Push back on yourself if your plan looks like this — the seam was there; you missed it.

### 4. Show the plan, get one approval

Present the chunk plan as a single message to the user with:
- The one-line restatement (so they catch misreads early)
- The chunks, each with seam + verification criteria
- Which files will be touched (full list)
- Anything from the input that you're explicitly **not** doing (the report said X, but you're leaving it out because Y)

Wait for approval before dispatching. This is the **only** mandatory checkpoint in the happy path. After approval, execution is autonomous until a chunk fails or all chunks ship.

### 5. Dispatch chunks via the Agent tool

For each chunk, call:

```
Agent({
  subagent_type: "general-purpose",
  description: "<short, 3-5 word>",
  prompt: <see template below>
})
```

The fresh agent gets only what you put in the prompt — no transcript inheritance, no implicit context. Treat the prompt as a complete brief: every file it needs to read, every constraint it must obey, every success criterion.

**Per-chunk prompt template** (paste this discipline into every Agent call):

````
You are executing one chunk of a brownfield change. The full plan is owned by another agent — you only see this chunk.

## Brownfield discipline (non-negotiable)

1. **Read before you write.** Open every file you're about to edit. Open its callers. Match the file's existing style (tabs/spaces, naming, comment density, import order).
2. **Use the named seam.** This chunk's spec names the function/file/route where the change belongs. Do not introduce a new file or a parallel implementation. If the seam doesn't exist as described, STOP and return: "seam-not-found: <what you looked for, where, what you found instead>". Do not improvise.
3. **Spec is law.** If the code can't be made to match the spec, return: "spec-conflict: <what the spec says, what the code requires, why they conflict>". Do not silently adjust the spec to fit the code.
4. **No drive-by refactors.** If you notice something else wrong, leave it. Note it at the end of your report. Do not fix it in this chunk.
5. **No new files unless this spec explicitly says so.** If you think you need one, you're probably missing the seam.
6. **Do not call the Agent tool.** No recursion. If this chunk needs subdivision, return: "chunk-too-large: <why>".
7. **No `as any`, no swallowed errors, no commented-out code.** Fix at the source or fail loudly.

## This chunk

### Goal
<one sentence — what behavior changes>

### Seam
<file:function or file:line where this lives>

### Spec
<exact change — be concrete; if updating a function, paste the current signature and the target signature>

### Files in scope
<full list — anything not listed here, you must NOT touch>

### Files to read for context (but not edit)
<list — the callers, the adjacent modules, the conventions to match>

### Success criteria
- tsc clean: `npx tsc --noEmit`
- <specific test must pass: `npx vitest run path/to/test.ts -t "name"`>
- <grep assertion: `Grep that <pattern> appears in <file>` — proves the seam was used>
- <anything else specific to this chunk>

### Return format
End your final message with:
```
STATUS: <green | seam-not-found | spec-conflict | chunk-too-large | failed-verification>
WHAT CHANGED: <one sentence, product-level>
FILES TOUCHED: <list>
VERIFICATION: <output of tsc + any tests you ran, summarized>
NOTES: <anything the orchestrator should know, including out-of-scope issues you noticed but didn't fix>
```
````

### 6. Verify each chunk's return

After the Agent returns, the orchestrator (you) does its own verification — don't trust the sub-agent's word:

- Re-run `npx tsc --noEmit` yourself
- Run any tests the chunk added or affected
- `Grep` to confirm the named seam was actually used (not a new parallel file)
- Read the diff for the touched files; check that style matches

If everything's green: mark the chunk complete in TodoWrite, dispatch the next one.

### 7. On failure, pause and ask

If verification fails — or the sub-agent returned a non-green STATUS — stop the loop. Surface to the user:
- Which chunk failed
- The sub-agent's STATUS + NOTES
- The verification output (tsc errors, test failures)
- The diff (or a summary of files touched)
- A one-line recommendation: retry with a clarified prompt, revise the chunk spec, or abandon

Do **not** dispatch the next chunk while waiting. Do **not** auto-retry. The user picks the recovery path.

(Per the design call: option (a). One-retry-on-flake is tempting but invites the sub-agent to invent files to make a test pass instead of fixing the seam — exactly the divergence brownfield discipline forbids.)

### 8. At the end, report

When all chunks complete green, summarize:
- What changed (product-level, one sentence)
- Where (file:line references)
- Verification status (tests passing, tsc clean, boot audit clean if applicable)
- What was explicitly **not** done (deferred from the input, with reason)

No filler. The user can read the diff for details.

---

## Strong defaults (don't argue with these)

- **The orchestrator never edits production code directly.** All edits go through dispatched sub-agents. The orchestrator only edits if a chunk fails and you've decided to recover by hand.
- **One chunk in flight at a time.** No parallel dispatch. Brownfield changes interfere with each other — chunk N+1's seam may have moved during chunk N.
- **Plan length matters.** Anything over ~8 chunks is probably misscoped. Either the task is too big (split into a sequence of /brownfield runs) or the chunks are too small (merge them).
- **The seam is sacred.** If you find yourself rationalizing a new file ("it's cleaner this way", "the existing function is too crowded"), stop. That's how brownfield codebases fork.
- **Tests added by chunks live in the existing test layout.** If `test/foo.test.ts` exists, new tests for foo go there. Don't create `test/foo-priority.test.ts` next to it.
- **When in doubt, ask.** One focused question to the user beats a chunk that ships the wrong thing.

---

## Anti-patterns — refuse or push back

- **Inventing a seam** because you couldn't find the real one. Return "seam-not-found" upstream; let the orchestrator decide.
- **Bundling cleanups with feature work.** If a chunk's diff touches files outside its scope, it's the wrong chunk.
- **Trusting the report.** A report's recommendation is a hypothesis. If translating it to this codebase requires inventing a new subsystem, the report was wrong for this codebase. Push back on the input, don't override the discipline.
- **Treating the spec as flexible.** If the spec says "extend `registerHook` to accept priority" and the code can't be extended, the answer isn't to silently change to "add `setPriority`." Return "spec-conflict" upstream.
- **Auto-retrying on failure.** The sub-agent's first failure is the most informative signal. Don't burn it.
- **Generating the plan from the report alone.** Always read the code first. The plan must reflect what the codebase actually looks like, not what the report assumes it looks like.

---

## Communication style

- **Direct.** "Chunk 3 failed — test/foo.test.ts:42 expected `priority` field, got `undefined`. Recommend: tighten chunk 2's spec to require the field on emit, not just on registration." beats three paragraphs of context.
- **Lead with status.** "3/7 chunks green, paused on 4." beats "I've been working through the plan and made some progress..."
- **Surface tradeoffs you actually made.** If the report wanted X and you shipped Y because X would have broken Z, say so. Don't hide it.
- **When you disagree with the report, say once, briefly, with the alternative.** Then either ship the report's version or yours — don't hedge.

---

## When to skip this skill

- The change is small enough to do inline (1-3 files, no architectural touch). Just do it.
- The task is a one-off bug fix in a file you already understand. /senior-engineer fits better.
- The codebase has no real seams yet (it's actually greenfield). Use the greenfield skill.
- The user is in tight pair-programming mode and wants to review every edit. Skill is overkill — collaborate directly.

---

## The one-liner

> **Find the seam. Match the style. Use the existing place. Don't fork.**

Everything else is implementation detail.
