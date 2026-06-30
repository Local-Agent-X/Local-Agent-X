/**
 * Attribution-confabulation guard — the assistant's final summary credits the
 * result it produced with a tool, model, or service it never used, usually by
 * dragging a name from earlier in the conversation into an unrelated artifact.
 *
 * Live failure 2026-06-29 (Grok): a thread that opened by ASKING about four AI
 * video generators (Runway/Kling/Luma/Pika) pivoted to a deck about the universe
 * built with web_search + image_search + presentation; the model narrated that
 * the deck "combines all four tools (Runway Gen-3 style, Kling depth, Luma/Pika
 * speed)" — crediting a static slideshow with four video generators it never
 * touched. Two different "4"s in the thread merged; stale context bled in.
 *
 * Sibling of action-claim (which catches "Removed X / Saved Y" ACTION claims and
 * is worker-only because it leaks a "the system is correcting me" line on chat):
 * this catches ATTRIBUTION claims ("combines/uses/in the style of X") on
 * interactive chat, where the failure lives. Same engine — the model-graded
 * verifier in claim-verify.ts — different question and trigger. The leak action-
 * claim avoids is handled here by RETRACTION (reason "attribution-confabulation"
 * is retractable): the false sentence is dropped and the nudged re-narration is
 * the only summary the user sees.
 *
 * A cheap phrase pre-filter keeps the LLM call off the hot path. Only a confirmed
 * confabulation fires (null/false → leave it) — the phrase gate alone is too weak
 * to nag a true "combines these tools" claim on. Fires once per op.
 */
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { verifyAttributionConfabulationWithLLM } from "../../classifiers/claim-verify.js";

interface FiredFlag { fired: boolean }

// Phrasing that CREDITS a result with a named tool/model/capability. Tight on
// purpose so the verifier stays off the hot path (NOT bare "uses" — that fires
// on "uses real sourced images"): each pattern pairs a credit verb with a
// tool/model cue, or matches the "combine all N tools" shape from the live case.
const ATTRIBUTION_PHRASES: RegExp[] = [
  /\bcombin(?:e|es|ing|ed)\b[^.?!]{0,40}\btools?\b/i,
  /\ball\s+(?:\d+|two|three|four|five|six)\b[^.?!]{0,30}\btools?\b/i,
  /\bin the style of\b/i,
  /\bpowered by\b/i,
  /\b(?:uses|using|leverag\w+|built with|incorporat\w+|blends?)\b[^.?!]{0,40}\b(?:model|generator|engine|api|service|tool)s?\b/i,
];

/** True when `text` reads as crediting the result with a named tool/model/
 *  capability (the shape worth a model-graded confabulation check). Pure + exported. */
export function looksLikeAttributionClaim(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return ATTRIBUTION_PHRASES.some((re) => re.test(t));
}

export const attributionClaimMiddleware: CanonicalMiddleware = {
  name: "attribution-claim",
  when: (ctx) => ctx.op.type === "chat_turn",

  async afterModelCall(ctx) {
    const text = ctx.assistantContent.trim();
    if (!text) return { kind: "continue" };
    if (!looksLikeAttributionClaim(text)) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(ctx.op.id, "attribution-claim", () => ({ fired: false }));
    if (flag.fired) return { kind: "continue" };

    // Only a confirmed confabulation fires. null (verifier down) / false →
    // never nag a true claim — the phrase gate is too weak to stand alone.
    const confirmed = await verifyAttributionConfabulationWithLLM(text, Array.from(ctx.toolsCalledThisOp));
    if (confirmed !== true) return { kind: "continue" };

    flag.fired = true;
    const used = ctx.toolsCalledThisOp.size > 0 ? Array.from(ctx.toolsCalledThisOp).join(", ") : "no tools";
    const message =
      `Your summary credits the result with a tool, model, or service you did NOT use this turn. ` +
      `What you actually used: ${used}. The work itself is already done — do not rebuild anything. ` +
      `Re-send your summary describing ONLY what you actually did and the real sources you pulled; ` +
      `drop any tool, model, or style you didn't use (a static document does not "use" a video generator).`;
    return { kind: "nudge", message, reason: "attribution-confabulation" };
  },
};
