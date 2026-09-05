/**
 * The durable "nobody ever opened this app" note that a PASSING app_build turn
 * emits when the smoke gate could not launch a browser.
 *
 * Why it is not just a stream chunk: a `[verify] smoke gate skipped` chunk dies
 * with the live bubble, so the user would never learn — after the fact — that
 * nothing opened their app. The durable channel is a committed assistant row.
 *
 * Why it carries the BUILD RESULT and not only the warning: being the last
 * assistant row makes it what `extractFinalAssistantText` returns, and that is
 * the ONLY text three consumers get —
 *   - `src/ops/tools/op-wait.ts` (a parent agent that awaited build_app),
 *   - `src/ops/tools/op-status.ts` (the same parent polling instead),
 *   - `src/broker-transport/phone-projection.ts` (the op card on mobile),
 * none of which carry an `appUrl` field of their own. A warning-only note would
 * hand a delegating agent a complaint in place of the deliverable and lose the
 * app's URL outright. `extractAppReadyUrl` has the same edge: it reads only the
 * NEWEST assistant row and gives up on a miss, so the legacy sidebar path it
 * backstops would lose its Open link too.
 *
 * So the note leads with the warning, then restates `APP_READY: <url>` on its
 * own line — the exact marker shape `extractAppReadyUrl` matches
 * (`/APP_READY:\s*(\S+)/`) and the app_build adapter emits — then quotes the
 * builder's own report. The URL sits near the TOP because both op_wait (2000
 * chars) and op_status (1500) truncate the tail.
 */
import type { AdapterReport, TurnInput } from "../adapter-contract.js";

/** Leader of the note. Tests and any future reader key off this, not prose. */
export const SMOKE_NO_BROWSER_MARKER = "NOT VERIFIED —";

/** How much of the builder's own report rides along: enough to stay a usable
 *  answer for a parent agent, short enough that neither consumer's truncation
 *  can reach the marker above it. */
const BUILDER_TEXT_CHARS = 700;

export interface UnverifiedNoteInput {
  /** The gate's account of why nothing opened the app, remedy included. */
  detail: string;
  /** The builder adapter's own final assistant text — the deliverable. */
  builderText: string;
  /** The URL the gate was going to smoke, when it had one. Fallback source of
   *  the APP_READY marker if the builder's text carried none. */
  url?: string;
}

/** The note's text. Separated from the report so it can be unit-tested without
 *  an adapter, and so the marker/URL invariant has one home. */
export function composeUnverifiedNote(note: UnverifiedNoteInput): string {
  const builderText = note.builderText.trim();
  const appUrl = builderText.match(/APP_READY:\s*(\S+)/)?.[1] ?? note.url;
  const quoted = builderText.length > BUILDER_TEXT_CHARS
    ? builderText.slice(0, BUILDER_TEXT_CHARS).trimEnd() + "…"
    : builderText;
  return [
    `${SMOKE_NO_BROWSER_MARKER} This app was never actually opened. The build's smoke check (load the page, ` +
      `screenshot it) and the vision check that reads those screenshots could not run — ${note.detail}`,
    ...(appUrl ? [`APP_READY: ${appUrl}`] : []),
    `The app was still built; it is reported done on the builder's word alone. Fix the above and rebuild to have ` +
      `it verified for real.`,
    ...(quoted ? ["", "The build's own final report:", "", quoted] : []),
  ].join("\n");
}

/**
 * Emit the note on the same `message_finalized` channel the failure-evidence
 * row uses: it joins the turn's committed messages, so it lands in op_messages
 * through commitTurn's own numbering — never written at record time (a
 * hand-numbered row poisons readOpMessages permanently). Role is ASSISTANT, not
 * user: this is the build speaking.
 *
 * What this does NOT guarantee: the row commits with the turn, so a cancel
 * between here and commitTurn drops it — along with the model's own final text.
 * There is no durable channel that survives an uncommitted turn.
 */
export function emitUnverifiedNote(
  input: TurnInput,
  report: (r: AdapterReport) => void,
  note: UnverifiedNoteInput,
): void {
  report({
    kind: "message_finalized",
    message: {
      messageId: `am-${input.opId}-${input.turnIdx}-unverified`,
      role: "assistant",
      content: { text: composeUnverifiedNote(note) },
    },
  });
}
