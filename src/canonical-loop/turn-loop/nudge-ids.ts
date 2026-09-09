/**
 * Nudge identity constants, kept in a LEAF module.
 *
 * nudges.ts reaches the op store, the event emitter and the guard-fire ledger.
 * `context/rule-registry.ts` needs nothing from that graph — only the id, to
 * assert the rule it registers matches the nudge that fires. Defining the ids
 * here lets the public sub-barrel (public/nudge-ids.ts) stay as light as the
 * seal's other pass-throughs; nudges.ts re-exports them, so the definition
 * stays in one place.
 */

/**
 * The one canonical wire-format nudge for a tool call that arrived as TEXT.
 * Keeps the `<wire-format-error: …>` frame the history-rebuild sanitizer
 * (anthropic-client/parse.ts) already stamps into rebuilt history, so the model
 * meets one vocabulary for the failure whichever path caught it. Used by the
 * unresolved-tool-intent completion gate (tool-intent-gate.ts).
 */
export const WIRE_FORMAT_NUDGE_ID = "wire-format";

/** @see WIRE_FORMAT_NUDGE_ID — the id `context/rule-registry.ts` references. */
export const WIRE_FORMAT_NUDGE =
  "<wire-format-error: your previous reply contained a tool call written as text. " +
  "It was NOT executed and produced no result. Reissue it now as a real structured " +
  "tool call, not as text.>";
