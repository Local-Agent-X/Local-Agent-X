---
name: blast-radius
description: Change-impact preflight before editing a SHARED ANCHOR — a default, enum, config loader, capability set, policy table, or widely-imported constant/type. Enumerates every consumer, flags the ones in a DIFFERENT concern than the one you're editing (the silent collateral), and forces you to run their tests and triage every failure root-cause-vs-environmental. Use when the user invokes /blast-radius, or BEFORE/AFTER changing any value that more than one site reads — especially a "default", a "policy", a flipped config flag, or one enum value that gates multiple behaviors. Catches "I changed X and it silently broke Y." Sibling to /canonical-check (which prevents forking a parallel system); this one prevents silently breaking a coupled one.
user-invocable: true
allowed-tools:
  - read
  - glob
  - grep
  - bash
  - agent_spawn
  - ask_user
---

# /blast-radius — Don't silently break a coupled system

A change that compiles can still break something three subsystems away. The bug
that motivates this skill: a file-access default was flipped `common →
unrestricted` as a *file-read convenience* — but the same enum value also gated
the shell inline-eval (`python -c`) defense, so the flip silently disabled a
security control nobody meant to touch. The test caught it, but only on a later
pull, on a different machine. This skill catches that **at change time**.

The user's rule:

> Before you change a value more than one place reads, find every reader, and
> name the ones in a different concern than the one you're editing. A change to
> a shared thing is a change to everything that shares it.

## When this fires

Run this skill (with no prompting from the user) before or right after a change that:

- Edits a **default** (a fallback `return`, a default param, a config default).
- Changes an **enum / union type**, or how one of its values is interpreted.
- Touches a **config loader / settings reader** (`load*`, `get*Config`, a `*.json` field).
- Modifies a **capability set, policy table, allowlist/denylist, or shared constant**.
- Flips a **feature flag** or changes what a flag gates.
- Touches a file matching `**/{config,settings,policy,defaults,registry,capabilit,types}*.{ts,js}`.
- The user describes the change with words like "default", "policy", "flip", "enable by default", "change the fallback".

Also runs on explicit invocation: `/blast-radius <symbol | file | "what I'm about to change">`.

Do **not** fire on a local change with no shared readers (a function used in one
place, a private field, a one-off string). This skill is for **shared anchors**.

## What this skill does

It is a **read-only preflight + verification gate**. It produces one of three verdicts:

- **SAFE** — every consumer is in the same concern you're editing. No silent collateral. Proceed.
- **REVIEW** — the symbol has consumers in a *different* concern/subsystem than your intent. Report lists each cross-concern consumer + the one load-bearing question ("you changed X for concern A; this also gates Y in concern B — intended?").
- **COUPLED** — one symbol/value gates two or more *semantically different* concerns (the welding smell). Report recommends decoupling before the change ships, so a future edit can't move one concern by touching the other.

It does **not** rubber-stamp. If consumers' tests aren't run and triaged, the verdict is not final.

## The procedure

### 1. Name the change in one sentence

"I am changing `<symbol>` from `<before>` to `<after>`, intending to affect `<concern>`."
If you can't name the symbol and the intended concern, ask one question and stop.

### 2. Enumerate every consumer

Don't trust intuition about who reads it — **verify**:

- If the repo has reach tooling, run it first; it is the compiler's list, not a
  search: `npm run refs -- <Symbol> --depth 2` (the declarations the change
  reaches, hop by hop, and the tests that use them) and, for a file or module,
  `npm run deps -- <path> --depth 2` (the files that reach it and every test
  importing one). Those test lists are step 4's tests to run. The searches below
  still cover what no import shows: string keys, enum literals, config fields.
- `grep` the symbol name across `src/` (and `public/`, `desktop/`, `packages/` if present). Include re-exports and barrels — follow them to real readers.
- For a config field, grep the **string key** too (`"fileAccessMode"`, `cfg.inlineEvalPolicy`) — readers often parse it by string, not by importing a constant.
- For an enum, grep each **value** (`"unrestricted"`, `"refuse"`) — a consumer may branch on the literal, not the type.
- For a default/loader, find callers of the loader AND callers that rely on the *absence* of an explicit argument (they inherit the default — these are the easy-to-miss ones).

For a wide or ambiguous surface, delegate to a **single** read-only helper agent (`agent_spawn` with the `reviewer` role): "Find every consumer of `<symbol>` in this repo. For each, report path + the concern it serves (e.g. file-access, shell-policy, UI, telemetry). Flag any consumer whose concern differs from `<intended concern>`." Don't fan out — one targeted sweep.

### 3. Classify each consumer by concern

For every reader, name the **concern** it serves. Then split:

- **Same-concern** consumers — expected; the change is meant to affect them.
- **Cross-concern** consumers — the blast radius. A file-access default that also
  reaches shell-policy, a "retry count" that also sizes a buffer, a "debug flag"
  that also disables auth. These are where silent breakage lives.

For a shared **enum**, run the welding check: does one value gate
*semantically-different* behavior across concerns? (`unrestricted` meaning both
"read any file" AND "allow inline-eval" is the canonical smell.) If yes → this is
trending toward **COUPLED**.

### 4. Run the consumers' tests — and triage every result

A verdict without verification is a guess. For the flagged consumers:

- Run their tests (the specific files, then the relevant suite). Prefer the repo's
  real gate (`npm run build` + the suite), not just a type-check — type-checking
  proves the code compiles, not that behavior held.
- **Triage EVERY failure** as **root-cause** (your change broke it) vs
  **environmental** (no network, real machine IP, fs.watch/timer flake, missing
  service). Never dismiss a red test as "probably flaky" without proving it, and
  never report green you didn't actually see.
- A cross-concern test that *passes* is the strongest SAFE signal. A cross-concern
  test that *fails* is the finding — root-cause it before proceeding.

### 5. Produce the verdict report

Output (in chat, terse, ~15 lines):

```
Blast-radius: <SAFE | REVIEW | COUPLED>

Changed: <symbol> — <before> → <after>  (intended concern: <X>)
Consumers: <n> total — <n> same-concern, <n> cross-concern

Cross-concern hits:
- <path>  → concern <Y>  → <does your change affect it? intended?>
- ...

Tests run: <which> — <pass/fail, and root-cause vs environmental for each fail>

Verdict rationale: <one sentence>

What to do:
- <SAFE: proceed>
- <REVIEW: the load-bearing question to answer before shipping>
- <COUPLED: split the symbol so concern Y stops riding concern X — name the seam>
```

If **COUPLED**, name the decoupling concretely: the new field/policy to introduce
and the call site to re-thread, so the fix is obvious. The remedy is an *invariant*
(a test asserting the two concerns move independently), not a one-off patch — that's
what stops the class from recurring.

### 6. Hand back

End with: "Proceed per the verdict above." The skill is the gate; the
implementation (and any decoupling) is the next step — run `/senior-engineer` for that.

## Anti-patterns this skill exists to prevent

- **"It's just a default change."** Defaults are the highest-leverage shared
  anchor there is — every caller that omits the argument inherits it. A default
  flip is a change to every implicit caller at once.
- **"It compiled, so it's fine."** `tsc` green proves types line up, not that a
  security gate still fires. Behavior lives in tests, and only if you run them.
- **"That test is probably just flaky."** Maybe. Prove it. The coupling that
  birthed this skill looked exactly like a flaky security test until someone read
  the assertion.
- **One knob, two jobs.** When a single value gates two concerns, every future
  change to one silently moves the other. Decouple; don't document the footgun.

## Anti-patterns for this skill itself

- Firing on a purely local change (one reader, private state). This is for shared anchors only.
- Producing a report longer than ~15 lines — it's a gate, not a design doc.
- Declaring SAFE without actually running the cross-concern consumers' tests.
- Implementing the change in this skill. The skill ends at the verdict.

## Relationship to other skills

- `/canonical-check` — prevents **forking** a new parallel system (structural). This prevents silently **breaking** a coupled one (impact). Run both before subsystem work.
- `/find-duplicate-systems` — backward-looking audit of existing duplication.
- `/senior-engineer` — the implementation methodology that runs *after* this verdict, including any decoupling the COUPLED verdict calls for.

## One-liner

> Before changing a shared value: find every reader, name the ones in a different
> concern, run their tests, triage every failure. SAFE / REVIEW / COUPLED, then hand back.
