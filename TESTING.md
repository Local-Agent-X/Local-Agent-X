# Testing convention

How we test LAX. The codebase is large and its bugs cluster at **seams** —
the boundaries where two subsystems meet (workspace × security, approval ×
loop × streaming, provider × tool dispatch). That's where surprises live, and
that's where test effort goes. Not blanket coverage — targeted.

## The rule

| Tier | When | Why |
|------|------|-----|
| **Regression test** | **Every bug, always** | Locks that exact bug class out. Nearly free. Non-negotiable. |
| **Seam test** | **The boundary you're already touching** | One test driving the real cross-module path. Coverage grows where the work is. |
| **Full suite** | **Rarely** | Don't retrofit big integration suites onto existing code — months of work, little payoff, and they rot. |

Default posture: **regression every bug · seam test what you touch · full suites rarely.**

## 1. Regression test every bug

A bug you fixed without a test will come back silently. With a test, it can
still break — but the suite screams. Write the test that *fails on the old
code and passes on the fix*, then delete the old behavior.

Examples in-repo:
- `src/security/layer-core.test.ts` → "platform-source write guard" — locks in
  that `workspace/` apps may use `src/` while `<repoRoot>/src` stays blocked.
- `test/approval-fingerprint.test.ts` → decline-suppression — a re-issued
  declined call is auto-declined, never re-prompts forever.

## 2. Seam tests, at the right altitude

The bug signature in this codebase is **locally plausible, globally wrong**
(`"block src/"` → a regex that matched `/src/` *everywhere*). A unit test with
mocks would have passed the buggy code too. So a seam test must:

- Drive the **actual cross-module path**, not a mocked stand-in for it.
- Use **realistic data** — real-looking paths, real arg shapes, the real
  fingerprint function. The bug hides in the data you didn't imagine.
- Assert the **boundary contract**, not internal mechanics — "a workspace app
  can write `src/`," not "the regex has N branches."

If mocking the thing under test makes the test pass, you tested the mock.

## 3. Prefer making the bug impossible over guarding it

Sometimes the right fix isn't a test — it's a sharper boundary. A structured
"is this platform code?" predicate beats a substring regex *plus* ten tests
babysitting it. A single chokepoint function (one place all destructive
approvals flow through) beats scattered checks. Reach for a better seam before
a bigger suite — especially for AI-generated code, where the type system and a
single source of truth catch the "looks right, isn't" class for free.

## Don't drown

Tests serve the goal — a system that gets more capable. They are not the
product. Don't let test-writing become the thing that stops you shipping. If a
suite is slow or flaky enough that you stop running it, it's worse than no
test: it's false confidence plus friction.

## Running

- Touched-subsystem sweep: `npx vitest run <files>` before committing.
- Full: `npx vitest run`. Typecheck: `npx tsc --noEmit`.
- A change isn't done because it compiles — it's done when you've *observed*
  the behavior: the bug reproduced, the fix verified, the test green.
