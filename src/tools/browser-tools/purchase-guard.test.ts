// The order button is the one browser click that spends the user's money: one
// yes per press, a repeat named as a second order, and no "it went through"
// without a confirmation on the page (the Amazon reorder, 2026-11-17).
import { describe, it, expect, beforeEach, vi } from "vitest";

const approvals = vi.hoisted(() => ({ asked: [] as Array<Record<string, unknown>>, answer: true }));
vi.mock("../../approval-manager.js", () => ({
  getApprovalManager: () => ({
    requestApprovalDetailed: async (opts: Record<string, unknown>) => { approvals.asked.push(opts); return { approved: approvals.answer }; },
  }),
}));

import { noteOrderClick, orderButtonOf, purchaseGate, REPEAT_WINDOW_MS, _resetPurchaseGuardForTest } from "./purchase-guard.js";
import { ok, err } from "../result-helpers.js";

const CHECKOUT = "https://www.amazon.com/gp/buy/spc/handlers/display.html";
const page = (...refs: Array<Record<string, unknown>>) => async () => ({ currentRefs: refs as never });
const sink = () => {};
let clock = 1_000_000;

beforeEach(() => {
  approvals.asked.length = 0; approvals.answer = true;
  clock = 1_000_000;
  _resetPurchaseGuardForTest(() => clock);
});

describe("orderButtonOf", () => {
  const none = page();
  it("finds the order button however the agent presses it", async () => {
    expect(await orderButtonOf("click", { ref: 7 }, page({ id: 7, name: "Place your order" }))).toBe("Place your order");
    expect(await orderButtonOf("click", { ref: 7 }, page({ id: 7, name: "", ids: { name: "placeYourOrder1" } }))).toBe("the order button");
    expect(await orderButtonOf("click", { selector: "input[name='placeYourOrder1']" }, none)).toBe("input[name='placeYourOrder1']");
    expect(await orderButtonOf("click_text", { text: "Buy Now" }, none)).toBe("Buy Now");
    expect(await orderButtonOf("act", { text: "click the Place your order button" }, none)).toBe("click the Place your order button");
    expect(await orderButtonOf("evaluate", { script: "document.querySelector('#submitOrderButtonId').click()" }, none)).toBe("an order button, from page script");
  });

  it("takes Enter or Space on a page with an order button as pressing it, and no other key", async () => {
    const checkout = page({ id: 4, name: "Add a gift receipt" }, { id: 9, name: "Place your order" });
    expect(await orderButtonOf("press", { key: "Enter" }, checkout)).toBe("Place your order");
    expect(await orderButtonOf("press", { key: "Space" }, checkout)).toBe("Place your order");
    expect(await orderButtonOf("press", { key: "Tab" }, checkout)).toBeNull();
    expect(await orderButtonOf("press", { key: "Enter" }, page({ id: 1, name: "Search" }))).toBeNull();
  });

  it("leaves every other click alone", async () => {
    expect(await orderButtonOf("click", { ref: 3 }, page({ id: 3, name: "Add to Cart" }))).toBeNull();
    expect(await orderButtonOf("click", { ref: 3 }, page({ id: 3, name: "Your orders" }))).toBeNull();
    expect(await orderButtonOf("click_text", { text: "Proceed to checkout" }, none)).toBeNull();
    expect(await orderButtonOf("navigate", { url: "https://www.amazon.com/buy-now" }, none)).toBeNull();
  });

  it("reads the page only for a click by ref", async () => {
    const look = vi.fn(page());
    await orderButtonOf("click_text", { text: "Place your order" }, look);
    expect(look).not.toHaveBeenCalled();
  });
});

describe("purchaseGate", () => {
  const press = { ref: 9 };
  const button = page({ id: 9, name: "Place your order" });

  it("asks every time, naming the site and the button, and runs only on a yes", async () => {
    const gate = await purchaseGate("click", press, CHECKOUT, "chat-1", sink, button);
    expect(gate).toEqual({ kind: "order", site: "amazon.com", label: "Place your order" });
    expect(approvals.asked[0]).toMatchObject({ toolName: "browser.place_order", alwaysAsk: true });
    expect(String(approvals.asked[0].context)).toContain('Place an order on amazon.com: press "Place your order"');
    approvals.answer = false;
    const no = await purchaseGate("click", press, CHECKOUT, "chat-1", sink, button);
    expect(no.kind).toBe("halt");
    expect(no.kind === "halt" && no.result.status).toBe("declined");
  });

  it("names a second order on the same site, from any chat, inside the window", async () => {
    const gate = await purchaseGate("click", press, CHECKOUT, "chat-1", sink, button);
    noteOrderClick(ok("Order placed, thank you"), gate);
    clock += 12 * 60_000;
    await purchaseGate("click", press, CHECKOUT, "chat-2", sink, button);
    expect(String(approvals.asked[1].context)).toContain("An order was already placed on amazon.com 12 minutes ago: approving this places a SECOND order.");
    clock += REPEAT_WINDOW_MS;
    await purchaseGate("click", press, CHECKOUT, "chat-2", sink, button);
    expect(String(approvals.asked[2].context)).not.toContain("SECOND");
  });

  it("does not remember a press that failed", async () => {
    const gate = await purchaseGate("click", press, CHECKOUT, "chat-1", sink, button);
    noteOrderClick(err("Element not found"), gate);
    await purchaseGate("click", press, CHECKOUT, "chat-1", sink, button);
    expect(String(approvals.asked[1].context)).not.toContain("SECOND");
  });

  it("parks an unattended run's order in the inbox, and the user's Approve there presses it once", async () => {
    const parked = await purchaseGate("click", { ...press, _callContext: "cron" }, CHECKOUT, "cron-1", sink, button);
    expect(parked.kind).toBe("halt");
    expect(parked.kind === "halt" && parked.result.metadata?.needsUser).toContain("Place an order on amazon.com");
    expect(approvals.asked).toHaveLength(0);
    const approved = await purchaseGate("click", { ...press, _callContext: "cron", _userGrant: "g1" }, CHECKOUT, "cron-1", sink, button);
    expect(approved.kind).toBe("order");
    expect(approvals.asked).toHaveLength(0);
  });

  it("does nothing for a click that places no order", async () => {
    expect(await purchaseGate("click", { ref: 2 }, CHECKOUT, "chat-1", sink, page({ id: 2, name: "Change address" }))).toEqual({ kind: "none" });
    expect(approvals.asked).toHaveLength(0);
  });
});

describe("noteOrderClick", () => {
  it("tells the agent it may claim the order only on a confirmation, and never to press again", () => {
    const out = noteOrderClick(ok("Clicked"), { kind: "order", site: "amazon.com", label: "Place your order" });
    expect(String(out.content)).toContain("ORDER BUTTON PRESSED");
    expect(String(out.content)).toContain("only if this page shows a confirmation");
    expect(String(out.content)).toContain("Never press it again for this request");
    expect(noteOrderClick(ok("Clicked"), { kind: "none" }).content).toBe("Clicked");
  });
});
