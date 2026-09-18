# Proposal: scope taint to the data flow, not the run

Status: **proposal — no policy code changed.** Written 2026-09-18 after a live
session was disarmed mid-task.

## What happened

A user asked the agent to set up the Gmail API. The agent read the inbox to
scope the work; some messages contained token-like content, which tainted the
session. From that point every browser *write* was denied:

```
BLOCKED by ARI kernel: blocked in ariRequired mode:
Tool call denied: Action 'http.post' denied:
behavioral rule triggered by egress attempt. Run has been quarantined.
```

The agent could not type into the Google Cloud console — a different site, with
content that demonstrably did not derive from those emails. It degraded to
reading steps aloud for the user to perform by hand. The user's summary: "this
basically makes the agent useless."

Two things were wrong. One is fixed; one is this proposal.

- **Fixed (175aba52):** the "Declassify & retry" card could not render for this
  block class, so the escape hatch the recovery text names did not exist. That
  was a reachability bug, not a policy question.
- **Open (this document):** the block itself is scoped to the RUN, not to the
  data. Clearing it requires a human, every time, for the rest of the session.

## The current rule

`browser` write actions (`click, fill, select, type, evaluate, act`) map to ARI
action `post` (`ari-action-map.ts:94`) — correct, a browser write is egress. Once
the session carries a taint label, a kernel behavioral rule fires on the egress
attempt and **quarantines the run**. The latch is session-wide and sticky: it
does not ask whether *these bytes* came from the tainted source.

## Why that is the wrong granularity

The repo already states the better principle. The threat engine's design is
*temporal signals SCORE, data-flow BLOCKS* — block when tainted bytes actually
reach a sink. And `enforce-policy.ts:106-125` already implements exactly that
for shell: it adjudicates payload evidence itself, and when there is none it
STRIPS the taint label before the kernel sees the call, with the comment:

> the whole-run brick this chunk removes

Shell got the surgical treatment. Browser writes never did, so they still take
the blunt one.

The asymmetry is the bug. A `fill` whose value is a string the user typed, on a
host unrelated to the tainted source, is not an exfiltration — and today it is
indistinguishable, to the kernel, from pasting a stolen token into an attacker's
form.

## Proposed rule

Give browser writes the same payload-evidence gate shell has:

1. Extract the outbound payload for the write (`egressPayload` already does this
   per capability class — `fill`/`type` value, `select` value, `evaluate` script).
2. Ask `checkEgressTaintWithPayload(sessionId, text)` — the existing data-flow
   check — whether those specific bytes derive from a tainted source.
3. **Evidence present** → block here, before `ariEvaluate`, as a `data-lineage`
   blocker carrying `clearable: "declassify"`. The user gets the card.
4. **No evidence** → strip the taint labels for this call only, exactly as the
   shell path does, and let the kernel evaluate everything else (grants,
   approvals, host allowlist) unchanged.

The kernel keeps every non-taint power it has. Genuine exfiltration still dies
at step 3 — and dies *earlier* than today, with a better message.

## What this deliberately does NOT do

- It does not weaken the canary rule. A canary token in a payload is proof, not
  a heuristic, and stays a hard block.
- It does not clear a quarantine raised by something other than taint.
- It does not remove the declassify card. Even perfectly scoped, a legitimate
  request ("copy the code from that email into this form") *should* stop and ask
  a human. Narrowing reduces how often the card is needed; it is still the
  release valve when the rule is right and the user still wants it.

## Risk

The honest risk: a value can launder its origin. A model that reads a token,
reasons about it, and types a *transformed* version defeats a payload-match
check. That is already true of the shell path — this proposal extends an
accepted trade rather than inventing one. The session-wide latch is strictly
stronger against laundering, at the cost of disarming the agent for every
unrelated task in the conversation.

If that trade is not acceptable, the alternative is to keep the latch and rely
on the now-working card — one click per quarantine instead of a dead session.
That is the status quo as of 175aba52, and it is a defensible place to stop.

## Test plan

- A `fill` on an unrelated host, session tainted, payload carrying none of the
  tainted bytes → allowed, no quarantine.
- The same `fill` whose value CONTAINS tainted bytes → blocked, `data-lineage`,
  `clearable: "declassify"`, card renders.
- A canary token in the payload → blocked regardless, not clearable.
- `evaluate` with a tainted string in the script → blocked (scripts are egress).
- After a taint-clearing declassify → the same call proceeds.
- Cross-seam: the shell path's existing tainted-shell tests must not move.

## Decision needed

Ship the narrowing, or keep the latch now that the card works? This changes what
the kernel blocks, so it is not mine to decide.
