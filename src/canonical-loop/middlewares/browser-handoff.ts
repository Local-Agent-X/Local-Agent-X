/**
 * Browser-handoff guard — an INTERACTIVE chat turn that drove the browser
 * earlier in the op ends tool-lessly by punting the task back to the user
 * ("dismiss it yourself", "give me an API token", "want me to keep driving or
 * switch to the API") while the page is still open and usable. The turn-loop
 * reads noTools+text as "done", so the task stops half-finished at the first
 * obstruction.
 *
 * Strong models keep driving — they clear a no-dismiss overlay with evaluate,
 * try click_text, switch tabs — instead of handing back. Weaker ones give up.
 * This is the interactive analogue of the worker-only premature-completion
 * gate: same "stopped without finishing" problem, but the signal that's safe
 * for chat is browser-in-use + hand-off phrasing (not "nothing committed",
 * which interactive turns legitimately produce).
 *
 * The trigger is an ATTEMPTED drive tool, not a successful one: a browser that
 * crashed mid-op then got punted back is the give-up we most need to catch, and
 * the crash keeps it out of the ok-only toolsCalledThisOp — so we gate on
 * attemptedToolsThisOp instead.
 *
 * The NUDGE fires at most once per op. Genuine blockers (a password, 2FA, a
 * CAPTCHA) are preserved — the nudge tells the model to keep that ask if it
 * truly needs the user, but only after it has tried to clear the obstruction.
 *
 * The give-up verdict is model-graded (`classifyGaveUp`) as the PRIMARY signal;
 * the HANDOFF_PATTERNS regex is the FALLBACK, used only when the classifier is
 * unavailable / times out. The verdict is computed once here and serves two
 * consumers: the keep-driving nudge (this gate) AND the terminal-outcome label
 * (decide-outcome.ts reads `opGaveUpUnrecovered`) — so an op that ends still
 * giving up records `partial`, never a rounded-up `clean`.
 */
import type { CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { classifyGaveUp } from "../../classifiers/give-up-classify.js";
import { recordGaveUpNudge, classifyOpCategory } from "../../tool-tracker.js";
import { createLogger } from "../../logger.js";

const log = createLogger("canonical-loop.browser-handoff");

interface FiredFlag {
  fired: boolean;
}

interface GiveUpVerdict {
  gaveUp: boolean;
}

const GIVE_UP_VERDICT_STATE = "give-up-verdict";

/**
 * The latest give-up verdict this gate computed for the op, persisted so the
 * terminal-outcome label (decide-outcome.ts) can read it. An op that ends still
 * flagged give-up must record as `partial`, not be rounded up to `clean` — the
 * gate is the single place the verdict is computed; the label is a pure reader.
 * Defaults to false, so ops the gate never evaluated (non-drive, no tool-less
 * turn) keep their prior clean/partial labeling untouched.
 */
export function opGaveUpUnrecovered(opId: string): boolean {
  return getMiddlewareState<GiveUpVerdict>(opId, GIVE_UP_VERDICT_STATE, () => ({ gaveUp: false })).gaveUp;
}

// Surfaces whose successful use earlier in the op means a live page/desktop is
// open — the precondition that makes "keep driving" the right nudge rather than
// nagging an ordinary tool-less chat answer.
const DRIVE_TOOLS = ["browser", "computer"];

// Phrases that mark a turn ENDING by deferring an obstruction to the user or
// declaring a soft block, as opposed to a genuine completion. Tuned to the
// give-up pattern seen on consent-banner / overlay punts; a "both tabs are
// open" success matches none of these.
const HANDOFF_PATTERNS: RegExp[] = [
  /\byou'?ll need to\b/i,
  /\bon your (end|side)\b/i,
  /\bswitch to the (api|token)\b/i,
  /\bwant me to keep (driving|going)\b/i,
  /\b(is|are) (still )?block(ing|ed)\b/i,
  /\b(i'?m|i am) (blocked|stuck|unable)\b/i,
  /\bgive me\b[^.?!]*\b(access|token|api|permission|credential)/i,
  /\b(dismiss|close|clear|disable|remove)\b[^.?!]*\b(yourself|manually|on your (end|side))\b/i,
  /\b(can|could|would) you\b[^.?!]*\b(dismiss|close|clear|disable|grant|provide|log ?in|sign ?in)\b/i,
  /\bi can'?t\b[^.?!]*\b(dismiss|close|clear|proceed|continue|access|finish)\b/i,
  /\bwhich (way|option)\b/i,
  /\bcannot be (dismiss|clos|clear|remov)\w*\b/i,
  /^\s*blocked\b/im,
];

function looksLikeHandoff(text: string): boolean {
  return HANDOFF_PATTERNS.some((re) => re.test(text));
}

export const browserHandoffMiddleware: CanonicalMiddleware = {
  name: "browser-handoff",

  when: (ctx) => ctx.op.type === "chat_turn",

  async afterModelCall(ctx) {
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    const text = ctx.assistantContent.trim();
    if (text.length === 0) return { kind: "continue" };
    // An ATTEMPTED drive tool — including one that errored or crashed — is the
    // precondition, not a SUCCESSFUL one. The give-up we most need to catch is
    // "the browser crashed, so the model punted the task back" — and the crash
    // keeps it out of the ok-only toolsCalledThisOp, so gating on success made
    // the gate blind to exactly that case. attemptedToolsThisOp includes it.
    if (!DRIVE_TOOLS.some((t) => ctx.attemptedToolsThisOp.has(t))) return { kind: "continue" };

    // Model-graded give-up verdict is PRIMARY — it catches punts regardless of
    // phrasing (the regex missed novel give-ups like "Blocked by overlay"). The
    // HANDOFF_PATTERNS regex is the FALLBACK, used only when the classifier is
    // unavailable / times out (null), preserving the prior behavior on that path.
    const gaveUp = await classifyGaveUp({ task: ctx.userMessage, finalText: text });
    const shouldFire = gaveUp ?? looksLikeHandoff(text);

    // Persist the verdict BEFORE the once-per-op short-circuit, every qualifying
    // turn. The terminal-outcome label reads this; computing it here (not a
    // second classifyGaveUp call at op-end) keeps one verdict path. Storing it
    // each turn means a post-nudge recovery — the model delivers on the next
    // turn, shouldFire flips false — correctly clears the give-up flag so a
    // recovered op still records clean.
    const verdict = getMiddlewareState<GiveUpVerdict>(
      ctx.op.id,
      GIVE_UP_VERDICT_STATE,
      () => ({ gaveUp: false }),
    );
    verdict.gaveUp = shouldFire;

    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "browser-handoff",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };
    if (!shouldFire) return { kind: "continue" };

    flag.fired = true;

    // Make the gate observable: a log line confirms the nudge fired (and which
    // path — model verdict vs regex backstop), and the durable per-model counter
    // lets the give-up rate be tracked across sessions, not inferred from action
    // counts. See tool-tracker.recordGaveUpNudge.
    const category = classifyOpCategory(ctx.toolsCalledThisOp);
    log.info(
      `give-up nudge fired — verdict=${gaveUp === true ? "classifier" : "regex-fallback"} ` +
      `model=${ctx.model} category=${category}`,
    );
    recordGaveUpNudge(category, ctx.model);

    const message =
      "The browser is still open and you're handing this back before exhausting your options. " +
      "The obstacle is not the goal:\n" +
      "- FIRST, get the answer directly — the content you need is usually already in the page " +
      "behind the overlay. `extract`/`observe` the text (or read it via `evaluate`) instead of " +
      "trying to clear the banner; a consent overlay is cosmetic, it doesn't remove the data underneath.\n" +
      "- If it's genuinely gated, reach the SAME goal another way — `web_fetch` the URL, a different/" +
      "print/amp URL, or another source. Don't loop trying to remove a cross-origin iframe " +
      "(Sourcepoint-style banners can't be clicked into) — switch routes instead.\n" +
      "- Only as a brief last resort, try to dismiss the banner (`click_text` its accept button).\n" +
      "Keep driving toward the answer. Only stop to ask me if you genuinely need something I alone " +
      "can provide (a password, a 2FA code, a CAPTCHA) — and say it once, concretely.";

    return { kind: "nudge", message, reason: "browser-handoff" };
  },
};
