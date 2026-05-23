---
name: refactor-godfiles
description: Auto-pilot splitting of god files (>400 LOC source files) in this repo. Runs in conservative batches of 3 parallel sub-agents with isolated worktrees, merges + pushes after each green batch, halts on regression. Use when the user invokes /refactor-godfiles, or asks to "split the rest of the god files" / "keep refactoring oversized files."
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

# /refactor-godfiles — Batched autopilot for splitting oversized files

The repo has a hard 400-LOC cap. This skill drives the long tail of splits
without the user having to baby-sit each one. It runs in conservative
batches so a bad split halts work before contaminating many files.

## Scope rules (what to touch, what to skip)

**Split:** source `.ts`/`.js`/`.py` files under `src/`, `packages/`, `python/`
that exceed 400 LOC.

**Skip — never split:**
- `test/**` and any `*.test.ts` / `*.test.js` / `*.spec.ts` files. Tests
  legitimately bundle related cases; splitting fragments the test story
  without benefit.
- `public/css/**`, `public/*.html` — different rules (markup/styling).
- `public/vendor/**`, anything with `.min.` in the name — vendor code.
- Type-barrel files (`types.ts`, `index.ts` that are just re-exports).
  Splitting a barrel just creates more barrels.
- `scripts/**` over 400 LOC — usually one-off setup scripts; ask before
  splitting.
- Any file whose top-of-file comment or recent commit history says it's
  about to be deleted, rewritten, or moved.

**Pause for human judgment on:**
- Files that handle security-critical paths (firewall, auth, secrets,
  approval-manager). The first 3 we shipped included
  `packages/arikernel/runtime/src/firewall.ts` (830 LOC) and it went
  cleanly, but the bar for "correctness preserved" is higher. Brief the
  sub-agent extra carefully and verify the test suite for the package
  passes (not just the global suite).
- Files where an agent's own report flags behavioral concerns. Do not
  proceed to the next batch until the user has reviewed.

## The loop

### 1. Inventory

Find the current god-file list with:

```
git ls-files | grep -E '\.(ts|js|mjs|cjs|py)$' | grep -v vendor/ | grep -v '\.min\.' \
  | xargs wc -l 2>/dev/null | awk '$1 > 400 && $2 != "total"' | sort -rn
```

Classify each candidate into `split` / `skip` / `human-judgment` using the
rules above. Show the user the classified list before starting — if the
list is dramatically different from what they expect, they redirect first.

### 2. Plan batches

- Batch size: **3 files in parallel**. More than 3 increases conflict risk
  on shared files (`src/types.ts`, `src/ops/tools.ts`).
- Order: largest first within each batch — the biggest files are the
  highest-value splits and also the riskiest, so they get attention while
  fresh.
- Don't batch two files that share a directory unless they're truly
  independent (e.g., two separate top-level files under `src/`). When in
  doubt, send them in different batches.

### 3. Brief each sub-agent

Use the `Agent` tool with `subagent_type: "claude"` and
`isolation: "worktree"`. Brief each agent with this template (substitute
file path + LOC count + any file-specific risk notes):

```
Split [FILE_PATH] ([CURRENT_LOC] LOC) into focused modules, each under 400 LOC.

Invoke the `/senior-engineer` skill first and follow that methodology
throughout.

Context — what's already established in this repo:
- 400 LOC cap is a hard rule (memory: feedback_commit_style.md).
- Recent precedent commits to match the splitting style:
    f9da94dd refactor(image-tools): split per tool into 3 modules
    75c82c28 refactor(telegram-bridge): split into 4 modules
    d922efde refactor(firewall): split into orchestrator + 5 modules
  Each extracted cohesive responsibilities and kept the original filename
  as a re-export barrel so callers don't break.
- No AI fingerprints in commit messages (no "Claude", no "AI", no
  co-author trailers). Multi-user app — fixes must ship in the repo.

Process:
1. Read the file end-to-end before splitting. Identify natural seams.
2. Propose the split structure in your head — don't write a plan doc.
3. Make the split. Preserve the public API at the original path via a
   re-export barrel.
4. Run `tsc --noEmit` and `npm test` from the repo root. Confirm no
   regressions vs baseline (86/87 — the `delegate` tool registration
   failure pre-existed and was removed in commit d0f60a4b, so current
   baseline may be 86/86).
5. Commit on the worktree branch with a message in the precedent style:
   `refactor(<short-name>): split into <N> modules by <axis>`.

Constraints:
- No behavior changes. Pure structural refactor.
- No new comments explaining what code does — only WHY comments if
  non-obvious.
- Every resulting file must be <400 LOC.
- Don't touch unrelated files.

Report back: new file list with LOC counts, test results, commit SHA on
the worktree branch, and any behavioral concerns you noticed (don't fix
them, just flag).
```

### 4. Run the batch in parallel

Launch all 3 agents in one message (multiple `Agent` tool calls in the
same response) with `run_in_background: true`. The harness notifies on
each completion.

### 5. Per-batch gate (after all 3 complete)

For each completed agent:
- Read its result.
- If it reports test failures or did NOT commit, mark the file as failed
  and skip the merge for that one.
- Otherwise cherry-pick its worktree branch commit onto `main`:
  `git cherry-pick <SHA>`. Two of the first three agents committed
  straight to `main` instead of their worktree branch — check
  `git worktree list` and `git log --oneline -5` to determine which case
  you're in before cherry-picking.

After all cherry-picks for the batch:
1. Run `tsc --noEmit` on main — must be clean.
2. Run `npm test` on main — must match prior baseline.
3. If both green: `git push origin main`.
4. Clean up each merged worktree:
   - `git worktree unlock <path>`
   - `git worktree remove --force <path>`
   - `git branch -D <branch>`

If the green gate fails, STOP. Do not start the next batch. Report the
regression to the user and wait.

### 6. Stop conditions (halt the autopilot, report to user)

Stop and wait for human review on any of:
- `tsc` regression on `main` after a batch merge.
- `npm test` count drops below baseline on `main`.
- Any sub-agent reports a behavioral concern in its result.
- Any sub-agent reports it could not preserve the public API.
- Push to `origin/main` is blocked by the classifier (the user has to run
  the push manually — pause until they confirm).
- The next file in line is in the `pause-for-human-judgment` set
  (security-critical files).

### 7. Progress tracking

Use `TodoWrite` to maintain a single list with one entry per god file,
states: `pending` → `in_progress` → `completed` / `skipped` / `failed`.
Update after each batch. The user can see at any moment which files are
done, which are queued, which failed.

## Communication style

- Before starting: one message showing the classified inventory and the
  first batch composition.
- Between batches: one short status update — "batch N done, M of K files
  split, X commits pushed. Starting next batch with [files]." Don't
  narrate per-agent.
- On halt: clear explanation of what stopped you and what the user needs
  to decide.
- On completion: final summary with total files split, LOC reduced, total
  commits pushed.

Don't repeatedly ask "should I continue?" — the user invoked the skill
because they want it to run. Stop only on the conditions above.

## Anti-patterns

- Running more than 3 in parallel "to go faster." Conflict risk
  outpaces speed gain.
- Skipping the per-batch test gate to save time. The whole point of
  batching is so a bad split fails small.
- Splitting a test file because it's >400 LOC. Tests are not god files.
- Splitting `types.ts` or barrel `index.ts` files. They're already
  re-export barrels.
- Re-running a failed agent on the same file without diagnosing why it
  failed. The failure tells you something about the file.
- Inventing a "while I'm in there" cleanup beyond the split. The diff is
  pure structural refactor.

## One-liner

> **Batched autopilot of 400-LOC splits. 3 in parallel, gated on tsc + tests
> + push after each batch, halt on the first regression or behavioral
> concern.**
