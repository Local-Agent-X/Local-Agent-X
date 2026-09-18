import { describe, it, expect } from "vitest";
import type { BrowserManager } from "../../browser/manager.js";
import type { InteractionResult } from "../../browser/backend.js";
import { handleClick, handleFill, handleClickText, handleSelect } from "./interact.js";
// handleAct's tests live in act.test.ts (they resolve via observe(), not snapshot()).

/**
 * BR-2: a ref/text interaction that fails every resolution strategy must come
 * back as an isError result. Only isError feeds the circuit breaker; a
 * success-prefixed failure with status ok invites the model to proceed on a
 * phantom click/fill. These tests would fail on the pre-fix code, which wrapped
 * every interaction outcome in ok().
 */

function fakeManager(over: Partial<Record<keyof BrowserManager, unknown>>): BrowserManager {
  return over as unknown as BrowserManager;
}

const fail = (text: string): InteractionResult => ({ ok: false, text });
const pass = (text: string): InteractionResult => ({ ok: true, text });

describe("BR-2 · interact handlers propagate InteractionResult.ok → isError", () => {
  it("handleClick(ref) surfaces a resolution failure as isError", async () => {
    const manager = fakeManager({
      clickByRef: async () => fail("[3] button — all resolution strategies failed. Re-observe the page."),
    });
    const r = await handleClick(manager, { ref: 3 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("all resolution strategies failed");
  });

  it("handleClick(ref) leaves a real click as a success result", async () => {
    const manager = fakeManager({ clickByRef: async () => pass("[3] click via role/name") });
    const r = await handleClick(manager, { ref: 3 });
    expect(r.isError).toBeFalsy();
  });

  it("handleFill(ref) surfaces a resolution failure as isError", async () => {
    const manager = fakeManager({
      fillByRef: async () => fail("[5] input — all resolution strategies failed. Re-observe the page."),
    });
    const r = await handleFill(manager, { ref: 5, value: "cats" });
    expect(r.isError).toBe(true);
  });

  /**
   * select used to demand a CSS selector while click and fill both took a
   * snapshot ref. muse (op-outcomes setup-account, run 20) observed the page,
   * sent {action:"select", ref:4, value:"LLC"}, was told "'selector' and
   * 'value' are required", invented CSS, timed out, and gave up on the form.
   */
  it("handleSelect takes a snapshot ref, like click and fill", async () => {
    const calls: Array<[number, string]> = [];
    const manager = fakeManager({
      selectByRef: async (ref: number, value: string) => { calls.push([ref, value]); return pass(`[${ref}] select via id`); },
    });
    const r = await handleSelect(manager, { ref: 4, value: "LLC" });
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([[4, "LLC"]]);
  });

  it("handleSelect surfaces a resolution failure as isError", async () => {
    const manager = fakeManager({
      selectByRef: async () => fail("[4] combobox — all resolution strategies failed. Re-observe the page."),
    });
    expect((await handleSelect(manager, { ref: 4, value: "LLC" })).isError).toBe(true);
  });

  it("handleSelect without ref or selector names both forms", async () => {
    const r = await handleSelect(fakeManager({}), { value: "LLC" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("'ref'");
    expect(r.content).toContain("'selector'");
  });

  it("handleClickText surfaces a not-found as isError", async () => {
    const manager = fakeManager({
      clickByText: async () => fail('no clickable element matching text "Buy" found'),
    });
    const r = await handleClickText(manager, { text: "Buy" });
    expect(r.isError).toBe(true);
  });
});
