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
 * Fires at most once per op. Genuine blockers (a password, 2FA, a CAPTCHA) are
 * preserved — the nudge tells the model to keep that ask if it truly needs the
 * user, but only after it has actually tried to clear the obstruction itself.
 *
 * The give-up verdict is now model-graded (`classifyGaveUp`) as the PRIMARY
 * signal; the HANDOFF_PATTERNS regex below is kept only as the FALLBACK, used
 * when the classifier is unavailable / times out.
 */
import type { CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { classifyGaveUp } from "../../classifiers/give-up-classify.js";

interface FiredFlag {
  fired: boolean;
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
    if (!DRIVE_TOOLS.some((t) => ctx.toolsCalledThisOp.has(t))) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "browser-handoff",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };

    // Model-graded give-up verdict is PRIMARY — it catches punts regardless of
    // phrasing (the regex missed novel give-ups like "Blocked by overlay"). The
    // HANDOFF_PATTERNS regex is the FALLBACK, used only when the classifier is
    // unavailable / times out (null), preserving the prior behavior on that path.
    const gaveUp = await classifyGaveUp({ task: ctx.userMessage, finalText: text });
    const shouldFire = gaveUp ?? looksLikeHandoff(text);
    if (!shouldFire) return { kind: "continue" };

    flag.fired = true;

    const message =
      "The browser is still open — you're handing this back before exhausting " +
      "what you can do from here. Before deferring to me:\n" +
      "- A no-dismiss overlay or consent banner is still clearable: use `evaluate` " +
      "to remove the node (or set display:none), or `click_text` on its button, " +
      "then re-`snapshot` and continue.\n" +
      "- If a click or fill missed, retry with a different ref/selector, or " +
      "`evaluate` to locate the right element.\n" +
      "Keep driving the task. Only stop to ask me if you genuinely need something " +
      "I alone can provide (a password, a 2FA code, a CAPTCHA) — and only after " +
      "you've actually tried to clear the obstruction yourself.";

    return { kind: "nudge", message, reason: "browser-handoff" };
  },
};
