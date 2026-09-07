/**
 * Browser action classification tables — the single source of truth for which
 * `browser` actions reset stall state, which are tracked for progress, which
 * are read-only (this also drives the tool's `effect` class), and which are
 * blocked while a human-verification challenge is on screen.
 *
 * Imported by index.ts (dispatcher + effect class) and gates.ts (gate
 * pipeline). An action name must appear in exactly one of these definitions —
 * never copied into a second list.
 *
 * IMMUTABILITY IS PART OF THE GATE. These are exported, and `const` binds the
 * reference, not the contents: a plain exported Set lets ANY importer call
 * `HUMAN_VERIFICATION_BLOCKED_ACTIONS.delete("evaluate")` and un-gate evaluate
 * on a CAPTCHA page, process-wide, for the life of the process.
 *
 * An earlier version tried to close that by shadowing add/delete/clear as own
 * frozen properties on the Set. That DID NOT WORK, and its test could not
 * notice: `Object.freeze` does not protect a Set's internal [[SetData]], and
 * `Set.prototype` was untouched, so
 * `Set.prototype.delete.call(TABLE, "evaluate")` — or `.clear.call(TABLE)` —
 * still emptied the table process-wide while the shadowed own methods dutifully
 * threw. The fix is not to harden a Set but to STOP EXPORTING ONE: the Set is
 * closed over inside sealedTable and no reference to it ever escapes, so there
 * is no receiver for any `Set.prototype.*` method to act on. Every call site
 * uses `.has()` or iteration, which is all ActionTable exposes.
 */

/** The read-only surface every consumer of these tables actually uses. Not a
 *  `ReadonlySet`: that type is satisfied by a real Set, and a real Set is
 *  exactly what must never leave this module. */
export interface ActionTable {
  has(action: string): boolean;
  readonly size: number;
  [Symbol.iterator](): IterableIterator<string>;
}

/** A table whose membership no importer can change — see the header. The Set
 *  lives only in this closure; the returned object is frozen and hands out
 *  nothing but answers and an iterator. */
function sealedTable(values: Iterable<string>): ActionTable {
  const set = new Set(values);
  return Object.freeze({
    has: (action: string): boolean => set.has(action),
    size: set.size,
    [Symbol.iterator]: (): IterableIterator<string> => set.values(),
  });
}

// Actions that establish a fresh page context — clear stall state, don't compare.
// close_tab counts: closing the active tab moves the agent onto a different page.
// emulate counts too: it drops the session's browser context and re-opens the
// current URL in a new (emulated) one, so the page it lands on is a fresh
// context whose fingerprint has nothing to be compared against.
export const RESET_ACTIONS = sealedTable(["navigate", "new_tab", "switch_tab", "close_tab", "close", "emulate"]);
// Advancing actions where "page never changed" means the agent is stuck.
// Click-style actions AND local edits (fill / select / scroll) all count: the
// enriched fingerprint (interactions.ts) tracks value length, scroll position,
// checked/selected state, and aria-expanded, so a PRODUCTIVE edit moves the
// fingerprint (never false-trips) while a dead one that changes nothing is
// still caught — this tracker is the ONLY browser-layer spin bound. Only pure
// READS (snapshot / observe / extract / screenshot / info / tabs) are excluded:
// a read never "tries to move the page", and blocking the agent's own
// re-perceive recovery move with the stall error is the opposite of helpful.
export const TRACKED_ACTIONS = sealedTable(["click", "click_text", "fill", "select", "scroll", "act"]);
export const READ_ONLY_ACTIONS = sealedTable(["snapshot", "extract", "screenshot", "tabs", "info", "observe", "read_console", "read_network", "read_response", "history", "bookmarks"]);
// Page-script evaluation is nominally inspection-only, but executing arbitrary
// page JavaScript can still invoke getters or site-defined functions with side
// effects. Dialog responses can likewise advance a challenge. Keep escape and
// observation actions available while the user completes verification.
//
// emulate is blocked here despite not being an "advancing" action: it destroys
// the session's browser context and re-navigates, which would throw away a
// challenge the user is part-way through solving.
export const HUMAN_VERIFICATION_BLOCKED_ACTIONS = sealedTable([
  ...TRACKED_ACTIONS,
  "evaluate",
  "dialog_accept",
  "dialog_dismiss",
  "emulate",
]);
