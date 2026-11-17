/**
 * The order button: the one browser click that spends the user's money.
 *
 * A chat that asked to "reorder the Purell" told the agent what to buy, not
 * that any click on any "Place your order" button, any number of times, is
 * fine. So, whatever the autonomy profile says:
 *
 *   1. one yes per order click: the click waits on an approval card naming the
 *      site and the button (alwaysAsk, so no earlier yes covers it); an
 *      unattended run parks it in the inbox instead;
 *   2. a repeat is named: if an order was placed on the same site in the last
 *      REPEAT_WINDOW_MS (from any chat), the card says this would be a second
 *      order and the agent is told to look at the order history first;
 *   3. no claim without proof: the click's result tells the agent it may say
 *      the order went through only if the page shows a confirmation.
 *
 * The agent clicks the button by ref, by its text, by a selector, by `act`, or
 * from page script; each is read here. A miss errs toward asking: a false
 * positive costs one extra tap on a card, a false negative a second order.
 */
import type { ServerEvent, ToolResult } from "../../types.js";
import type { BrowserObservation } from "../../browser/observation-types.js";
import { getApprovalManager } from "../../approval-manager.js";
import { blocked, declined, needsUser } from "../result-helpers.js";
import { toolCallIdOf, unattendedCall, userGrantOf } from "../../tool-execution/internal-args.js";

/** A control that places an order, by its own name. */
const ORDER_CONTROL =
  /^(?:place (?:your |my |the )?order(?: and pay)?|buy now|buy it now|complete (?:my |your |the )?(?:purchase|order|checkout)|submit (?:my |your |the )?order|confirm (?:and pay|purchase|order|payment)|pay now|pay \$?[\d.,]+(?: now)?|place order now)$/i;
/** The same, inside a sentence: `act`'s instruction, a click_text. */
const ORDER_PHRASE =
  /\b(?:place (?:your |my |the )?order|buy (?:it )?now|complete (?:my |your |the )?(?:purchase|checkout)|submit (?:my |your |the )?order|pay now|confirm (?:and pay|purchase|order))\b/i;
/** The same as code spells it: an element id or name ("placeYourOrder1"), a
 *  CSS selector, page script. */
const ORDER_IDENT = /place[ _-]?(?:your[ _-]?)?order|buy[ _-]?now|submit[ _-]?order|complete[ _-]?purchase|pay[ _-]?now/i;

export const REPEAT_WINDOW_MS = 2 * 60 * 60_000;

const placed = new Map<string, number>();
let now: () => number = Date.now;

function siteOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "") || "this site"; } catch { return "this site"; }
}

/** The order button this call would press, by its label; null when it presses
 *  none. `look` is the page's observation, read only for a click by ref. */
export async function orderButtonOf(
  action: string,
  args: Record<string, unknown>,
  look: () => Promise<Pick<BrowserObservation, "currentRefs">>,
): Promise<string | null> {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  switch (action) {
    case "click": {
      if (args.ref !== undefined && args.ref !== null) {
        const ref = (await look()).currentRefs.find((r) => r.id === Number(args.ref));
        const name = ref?.name.trim() ?? "";
        return ORDER_CONTROL.test(name) || ORDER_IDENT.test(ref?.ids?.id ?? "") || ORDER_IDENT.test(ref?.ids?.name ?? "") ? name || "the order button" : null;
      }
      const selector = text(args.selector);
      return ORDER_IDENT.test(selector) ? selector : null;
    }
    case "click_text": return ORDER_CONTROL.test(text(args.text)) || ORDER_PHRASE.test(text(args.text)) ? text(args.text) : null;
    case "act": return ORDER_PHRASE.test(text(args.text) || text(args.value)) ? text(args.text) || text(args.value) : null;
    case "evaluate": return ORDER_IDENT.test(text(args.script)) || ORDER_PHRASE.test(text(args.script)) ? "an order button, from page script" : null;
    default: return null;
  }
}

/** When an order was last placed on `site` within the repeat window. */
function recentOrder(site: string): number | null {
  const at = placed.get(site);
  return at !== undefined && now() - at < REPEAT_WINDOW_MS ? at : null;
}

function minutesAgo(at: number): string {
  const m = Math.max(1, Math.round((now() - at) / 60_000));
  return m === 1 ? "a minute ago" : `${m} minutes ago`;
}

export type OrderGate = { kind: "none" } | { kind: "halt"; result: ToolResult } | { kind: "order"; site: string; label: string };

/** Ask for this order click, or say why it may not run. */
export async function purchaseGate(
  action: string,
  args: Record<string, unknown>,
  pageUrl: string,
  sessionId: string,
  onEvent: ((e: { type: string; [k: string]: unknown }) => void) | undefined,
  look: () => Promise<Pick<BrowserObservation, "currentRefs">>,
): Promise<OrderGate> {
  const label = await orderButtonOf(action, args, look);
  if (!label) return { kind: "none" };
  const site = siteOf(pageUrl);
  if (userGrantOf(args) !== undefined) return { kind: "order", site, label };
  const prior = recentOrder(site);
  const repeat = prior === null ? "" : ` An order was already placed on ${site} ${minutesAgo(prior)}: approving this places a SECOND order.`;
  const ask = `Place an order on ${site}: press "${label}". This spends money and may not be undoable.${repeat}`;
  if (!onEvent || unattendedCall(args)) {
    return { kind: "halt", result: needsUser(blocked(
      `BLOCKED: pressing "${label}" places an order on ${site}, and each order needs the user's own yes.`,
      { layer: "browser-purchase", browserStatus: "approval-required", recovery: "This run cannot ask the user. Tell them the order is ready to place; their Approve in the inbox presses the button once." },
    ), ask) };
  }
  const outcome = await getApprovalManager().requestApprovalDetailed({
    toolName: "browser.place_order",
    toolCallId: toolCallIdOf(args) ?? `browser-order-${sessionId}`,
    sessionId,
    context: `${ask} Approve only if this is the order you asked for.`,
    args: { action, site, button: label },
    alwaysAsk: true,
    emit: onEvent as (event: ServerEvent) => void,
  });
  if (outcome.approved) return { kind: "order", site, label };
  return { kind: "halt", result: declined(
    `The user did not approve placing the order on ${site}; "${label}" was not pressed. Do not press it another way. Ask them what they want.`,
    { layer: "browser-purchase", browserStatus: "declined" },
  ) };
}

/** After an approved order click: remember it, and tell the agent what it may
 *  claim. A failed click places nothing and is not remembered. */
export function noteOrderClick(result: ToolResult, gate: OrderGate): ToolResult {
  if (gate.kind !== "order" || result.isError) return result;
  placed.set(gate.site, now());
  const note =
    `\n\nORDER BUTTON PRESSED ("${gate.label}" on ${gate.site}). Tell the user the order went through only if this page shows a confirmation ` +
    "(an order number, or words like \"Order placed\" / \"Thank you, your order\"). If it does not, say you can't confirm it yet and check the site's " +
    "order history before anything else. Never press it again for this request: a second press can place a second order.";
  return typeof result.content === "string" ? { ...result, content: `${result.content}${note}` } : result;
}

/** Test seams. */
export function _resetPurchaseGuardForTest(clock: (() => number) | null = null): void { placed.clear(); now = clock ?? Date.now; }
