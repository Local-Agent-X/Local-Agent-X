/**
 * Browser action classification tables — the single source of truth for which
 * `browser` actions reset stall state, which are tracked for progress, which
 * are read-only (this also drives the tool's `effect` class), and which are
 * blocked while a human-verification challenge is on screen.
 *
 * Imported by index.ts (dispatcher + effect class) and gates.ts (gate
 * pipeline). An action name must appear in exactly one of these definitions —
 * never copied into a second list.
 */

// Actions that establish a fresh page context — clear stall state, don't compare.
// close_tab counts: closing the active tab moves the agent onto a different page.
export const RESET_ACTIONS = new Set(["navigate", "new_tab", "switch_tab", "close_tab", "close"]);
// Advancing actions where "page never changed" means the agent is stuck.
// Click-style actions AND local edits (fill / select / scroll) all count: the
// enriched fingerprint (interactions.ts) tracks value length, scroll position,
// checked/selected state, and aria-expanded, so a PRODUCTIVE edit moves the
// fingerprint (never false-trips) while a dead one that changes nothing is
// still caught — this tracker is the ONLY browser-layer spin bound. Only pure
// READS (snapshot / observe / extract / screenshot / info / tabs) are excluded:
// a read never "tries to move the page", and blocking the agent's own
// re-perceive recovery move with the stall error is the opposite of helpful.
export const TRACKED_ACTIONS = new Set(["click", "click_text", "fill", "select", "scroll", "act"]);
export const READ_ONLY_ACTIONS = new Set(["snapshot", "extract", "screenshot", "tabs", "info", "observe", "read_console", "read_network", "read_response", "history", "bookmarks"]);
// Page-script evaluation is nominally inspection-only, but executing arbitrary
// page JavaScript can still invoke getters or site-defined functions with side
// effects. Dialog responses can likewise advance a challenge. Keep escape and
// observation actions available while the user completes verification.
export const HUMAN_VERIFICATION_BLOCKED_ACTIONS = new Set([
  ...TRACKED_ACTIONS,
  "evaluate",
  "dialog_accept",
  "dialog_dismiss",
]);
