import { describe, it, expect } from "vitest";
import type { BrowserManager } from "../../browser/manager.js";
import type { InteractionResult } from "../../browser/backend.js";
import { handleClick, handleFill, handleClickText } from "./interact.js";
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

  it("handleClickText surfaces a not-found as isError", async () => {
    const manager = fakeManager({
      clickByText: async () => fail('no clickable element matching text "Buy" found'),
    });
    const r = await handleClickText(manager, { text: "Buy" });
    expect(r.isError).toBe(true);
  });
});
