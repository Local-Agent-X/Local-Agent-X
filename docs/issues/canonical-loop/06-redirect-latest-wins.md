# Issue 06 — Redirect latest-wins at turn boundary

**Phase:** Vertical slice
**Blocks:** 11
**Blocked by:** 03

---

## Goal

Implement `op_redirect` with latest-wins semantics: a redirect instruction lands on `ops.redirect_instruction`, the loop folds it into the next turn's prompt assembly at the turn boundary, emits `redirect_received` on intake and `redirect_applied` on consumption, and clears the column. A second redirect arriving before the first applies overwrites the first; only one `redirect_applied` is emitted. Implements PRD acceptance tests #5 and #6.

## Why it matters

Redirect is the third leg of the control plane and the one most easily over-engineered. Locking latest-wins keeps semantics simple and is the agreed v1 behavior. Shipping it now keeps every later migration (Codex, build, IDE) on the same control surface.

## Scope

- Public API `op_redirect(op_id, instruction, actor)`:
  - Writes `ops.redirect_instruction` (latest-wins overwrite) and `ops.redirect_received_at`.
  - Emits `redirect_received` event with `instruction_id`.
  - Publishes fast-path signal on bus.
- Loop intake at next prompt assembly:
  - `turn_loop` reads `redirect_instruction` before assembling prompt.
  - Folds instruction into prompt (mechanism: append as a control message via `op_messages` with role `control`, or via adapter input — pick the cleaner path during impl, document in commit).
  - On commit, emits `redirect_applied` with same `instruction_id`, marks `op_turns.redirect_consumed=true`, clears `redirect_instruction`.
- Precedence with pause/cancel:
  - `cancel` always wins (issue 07).
  - `pause` and `redirect` can coexist; if pause is also pending at the turn boundary, redirect is consumed during the *next* turn after resume (or applied first if both are present and we resume cleanly — document chosen semantics).

## Non-goals

- Multi-redirect queueing (latest-wins only).
- Redirect-with-canceled-prompt — out of scope.
- UI for instruction composition.
- Per-turn redirect (mid-turn redirect application) — explicitly disallowed per PRD.

## Likely files / modules

- `src/canonical-loop/control-api.ts` — adds `op_redirect`.
- `src/canonical-loop/turn-loop.ts` — read + fold + clear at turn boundary.
- `src/canonical-loop/checkpoint.ts` — write `redirect_consumed` on commit.
- `tests/canonical-loop/redirect.test.ts`.

## Dependencies / blockers

- Issue 03 (loop happy path).

## Acceptance criteria

- PRD acceptance test #5 (redirect at turn boundary) passes:
  - `op_redirect` mid-turn.
  - Current turn finishes (no mid-turn application).
  - Next turn's prompt includes the instruction.
  - `redirect_applied` event emitted with same `instruction_id`.
  - `redirect_instruction` column cleared.
  - `op_turns.redirect_consumed=true` for that turn.
- PRD acceptance test #6 (latest-wins redirect) passes:
  - Two `op_redirect` calls in quick succession.
  - Second overwrites first.
  - Only the second is consumed and yields a single `redirect_applied` event.
  - First instruction is not re-emitted.
- Audit: `op_events` shows two `redirect_received` events (one per call) but only one `redirect_applied`.

## Tests required

- PRD test #5.
- PRD test #6.
- Edge: redirect immediately after submission, before any turn runs — applied on the very first turn.
- Edge: redirect after pause but before resume — pending instruction survives the pause and is applied on first resumed turn.
- Cancel-overrides-redirect: redirect set, then cancel set, then turn boundary reached — redirect not applied; op cancels.

## Definition of done

- [ ] `op_redirect` live; documented.
- [ ] PRD tests #5 and #6 green.
- [ ] Pause/redirect interaction documented in commit message + module README.
- [ ] No untouchable modified.
- [ ] Modules within 400 LOC.
