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
 * on a CAPTCHA page, process-wide, for the life of the process. sealedSet()
 * closes that: mutation is a type error at compile time (ReadonlySet) and
 * throws at runtime (own frozen add/delete/clear). `.has()` and iteration are
 * unchanged.
 */

/** A Set that cannot be mutated by an importer — see the header. */
function sealedSet(values: Iterable<string>): ReadonlySet<string> {
  const set = new Set(values);
  const deny = (op: string) => () => {
    throw new TypeError(`browser action tables are immutable: ${op}() is not permitted`);
  };
  return Object.freeze(Object.assign(set, {
    add: deny("add"),
    delete: deny("delete"),
    clear: deny("clear"),
  })) as unknown as ReadonlySet<string>;
}

// Actions that establish a fresh page context — clear stall state, don't compare.
// close_tab counts: closing the active tab moves the agent onto a different page.
// emulate counts too: it drops the session's browser context and re-opens the
// current URL in a new (emulated) one, so the page it lands on is a fresh
// context whose fingerprint has nothing to be compared against.
export const RESET_ACTIONS = sealedSet(["navigate", "new_tab", "switch_tab", "close_tab", "close", "emulate"]);
// Advancing actions where "page never changed" means the agent is stuck.
// Click-style actions AND local edits (fill / select / scroll) all count: the
// enriched fingerprint (interactions.ts) tracks value length, scroll position,
// checked/selected state, and aria-expanded, so a PRODUCTIVE edit moves the
// fingerprint (never false-trips) while a dead one that changes nothing is
// still caught — this tracker is the ONLY browser-layer spin bound. Only pure
// READS (snapshot / observe / extract / screenshot / info / tabs) are excluded:
// a read never "tries to move the page", and blocking the agent's own
// re-perceive recovery move with the stall error is the opposite of helpful.
export const TRACKED_ACTIONS = sealedSet(["click", "click_text", "fill", "select", "scroll", "act"]);
// layout_report belongs here: it reads geometry, computed style and matching
// media queries and mutates nothing, so the tool's declared effect class for it
// is honestly "read-only".
export const READ_ONLY_ACTIONS = sealedSet(["snapshot", "extract", "screenshot", "tabs", "info", "observe", "read_console", "read_network", "read_response", "history", "bookmarks", "layout_report"]);
// Page-script evaluation is nominally inspection-only, but executing arbitrary
// page JavaScript can still invoke getters or site-defined functions with side
// effects. Dialog responses can likewise advance a challenge. Keep escape and
// observation actions available while the user completes verification.
//
// The two script-or-context actions are blocked here despite not being
// "advancing" ones:
//   - emulate destroys the session's browser context and re-navigates, which
//     would throw away a challenge the user is part-way through solving;
//   - layout_report executes script in the challenge page. The script is fixed
//     and read-only, but a challenge page is the one place where running ANY
//     script is worth refusing, and the diagnostic is worthless on a challenge
//     interstitial anyway. It is therefore the ONE read-only action that is
//     blocked here (pinned as such in action-tables.test.ts).
export const HUMAN_VERIFICATION_BLOCKED_ACTIONS = sealedSet([
  ...TRACKED_ACTIONS,
  "evaluate",
  "dialog_accept",
  "dialog_dismiss",
  "emulate",
  "layout_report",
]);
