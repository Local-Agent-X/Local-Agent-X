# Sweep-completeness benchmark

A behavioral benchmark for **one class of task**: a codebase-wide
terminology/concept **migration** — *"a thing was removed; find and fix every
stale reference across the whole project, tell live rot from legitimate history,
and don't break load-bearing vestigial code."*

It is **not** a unit test and it does **not** run in CI. It measures whether the
**harness** drives a model to *enumerate → sweep → verify*, or lets it
**under-scope** (edit what it stumbled on and declare done). The same prompt is
run through different models — and different harnesses — against one identical
clean baseline; each run is graded on a fixed rubric. The point is the
**before/after** delta when we change the harness.

## The task

- **Repo under test:** `agentxos-mobile` (sibling repo), clean baseline `69df058`.
- **Why it's a good fixture:** Tailscale/tailnet was genuinely removed
  (`transportMode()` is hardcoded `'broker'`), but ~35 files still carry tailnet
  references — a *mix* of present-tense lies that must change (a false
  `constitution.md` non-negotiable, a "DARK BY DEFAULT" README, ATS config
  comments) and legitimate "replaced the old tailnet X" history that must stay.
  It also contains a **trap**: `StoredPairing.tailnetAddr` looks like dead naming
  but is a load-bearing sentinel — deleting it breaks the broker fetch path.
- **Prompt (verbatim, identical for every run):**

  > We switched this app off Tailscale a while back — it goes through our broker
  > for everything now. There are still a bunch of out-of-date tailnet/Tailscale
  > references left over in the code. Go through the project and finish cleaning
  > them up. Don't break anything.

- **Reset between runs:** `git -C <agentxos-mobile> restore .` back to `69df058`.
- **Confirm the real model** from `~/.lax/logs/server.log` `[chat-diag] prepared`
  — never self-report (a Codex OAuth session can silently fall back to Grok).
- **Grade by inspecting the diff** + running `tsc` and the suite (352 tests).

## Rubric

| Signal | What it measures |
|---|---|
| Enumerated first | did it `grep`/`glob` the whole surface before editing? |
| Trap handled | `StoredPairing.tailnetAddr`: renamed (safe) / deleted (breaks broker) / untouched |
| Completeness | how much of the real surface it covered |
| Verified | ran `tsc` + the 352-test suite and reported honestly |
| New defect | did it introduce an inconsistency (e.g. comment ↔ code drift)? |
| Over-reach | did it purge legitimate "replaced the old X" history? |
| **Score** | /10 |

## BEFORE — stock harness, no enumerate-first guard (2026-06-30)

| | **Grok-4.3** | **GPT-5.5** | **Opus-4.8** (in LAX) |
|---|---|---|---|
| Files changed | 2 (4 lines) | 30 | 45 |
| Enumerated first | ❌ no | ✅ yes (code) | ✅ yes (whole repo) |
| Trap | never reached it | renamed → `bridgeAddr` | renamed → `desktopAddr` |
| `app.config.ts` | missed | missed | ✅ caught |
| false `constitution.md` | missed | missed | ✅ caught |
| Verified (tsc + 352) | ❌ none | ✅ | ✅ |
| New defect | comment/code mismatch | none | none |
| Over-reach | n/a | none | none (breadth earned) |
| **Score** | **3** | **8.5** | **9.5** |

**Finding:** the single differentiator is a **reflex** — *enumerate-the-surface-
first*. Grok skipped it (edited what it stumbled on); GPT and Opus both grepped
the tree, built a worklist, swept, and re-checked. That one habit is the whole
gap between 3 and 8.5+. Opus's extra point over GPT is just a **wider**
enumeration (docs + spec + scenarios + store copy, not only code).

## The harness change

`broad-sweep-nudge` middleware — commit **62dd6948**
([src/canonical-loop/middlewares/broad-sweep-nudge.ts](../../src/canonical-loop/middlewares/broad-sweep-nudge.ts)).
When the task reads as a codebase-wide sweep **and** the model wraps up
tool-lessly **and** it never ran `grep`/`glob` this op, it injects one forced
nudge to enumerate the full surface before finishing. Gated three ways,
fire-once, all lanes; mirrors the existing `tool-search-nudge` pattern (no new
subsystem, no LLM call, no prompt bloat).

## AFTER — with broad-sweep-nudge live (PENDING)

| | **Grok-4.3 + nudge** |
|---|---|
| Files / score | _(to run: rebuild + restart LAX, re-run the prompt on `69df058`)_ |

**Hypothesis:** Grok goes 3 → a real sweep once the nudge forces enumeration. If
it nudges but Grok *still* under-delivers, the nudge needs teeth — escalate into
the force-another-turn path (`open-steps` / `premature-completion`) instead of a
one-shot message.

## Cross-harness axis — same model, different harness

Opus-4.8 ran this **exact task** in two harnesses: in **LAX** (45 files, several
minutes, tripped its context-trim **twice**, re-greeted mid-run) and in a
**reference CLI agent** running the same Opus-4.8 weights. Same model, very
different wall-clock. The harness — not the model — sets the speed:

- **Per-turn LLM side-calls.** LAX runs give-up / intent / attribution /
  hallucination classifiers *between* turns — extra round-trips that make no code
  progress. The reference CLI has ~none. *(Likely the biggest factor.)*
- **Heavier per-turn prompt.** LAX rebuilds ~200 lines of doctrine + memory +
  a situational-awareness digest + persona **every turn**; more input to process
  per step.
- **Mid-run compaction.** LAX summarized + re-oriented twice; each burns a
  round-trip and a re-greet turn on non-work.
- **Persona / narration output.** LAX's identity layer spends output tokens
  talking in character; the reference CLI is action-terse.
- **Forced extra turns.** `open-steps` / `premature-completion` / `verify-gate`
  can each force "one more turn" — safety that costs wall-clock.

**The irony, and the real question:** most of that overhead is exactly what made
LAX-Opus the *most thorough* run (9.5). This benchmark's job isn't "which is
faster" — it's *"what does the overhead buy, and which of it is pure waste vs.
real thoroughness."* Definitive per-stage timings live in the
`[step]`/`[timing]` lines of `server.log`.

## How to run a row

1. `git -C <agentxos-mobile> restore .` (baseline `69df058`).
2. Set the model in LAX; confirm it from `server.log` `[chat-diag] prepared`.
3. Paste the prompt above into a fresh LAX chat. Let it finish.
4. Grade: `git -C <agentxos-mobile> diff --stat`, then `cd app && npx tsc
   --noEmit && npx jest`. Fill in a row. Revert.
