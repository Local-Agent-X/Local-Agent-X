import { describe, it, expect } from "vitest";
import type { BrowserBackend, InteractionResult } from "../../browser/backend.js";
import type { BrowserObservation, DurableRef } from "../../browser/observation.js";
import { USER_TOOK_WHEEL } from "../../browser/in-app-actions.js";
import { handleAct } from "./act.js";

/**
 * handleAct must resolve the target against the FULL current element list
 * (manager.observe().currentRefs), NOT manager.snapshot(). After the first
 * observation snapshot() returns a DIFF — "Page unchanged since last
 * observation" or "+added/-removed/~changed" — so a stable element the user
 * asks to act on is absent from it. Every manager below returns that diff shape
 * from snapshot(); the tests prove act still finds the ref via observe().
 */

const pass = (text: string): InteractionResult => ({ ok: true, text });
const fail = (text: string): InteractionResult => ({ ok: false, text });

// snapshot() as it behaves after the first observation: a diff, never the full
// element list. This is the exact shape that used to defeat handleAct.
const DIFF_SNAPSHOT =
  "Page: Example — https://example.com\nPage unchanged since last observation — same refs still valid.";

function ref(id: number, role: string, name: string, extra: Partial<DurableRef> = {}): DurableRef {
  return {
    id, role, name, signature: `${role}|${name}`, tag: "", type: "", xpath: "",
    inViewport: true, lastSeen: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, ...extra,
  };
}

function makeObs(currentRefs: DurableRef[]): BrowserObservation {
  return {
    url: "https://example.com", title: "Example", isInitial: false,
    added: [], removed: [], changed: [], offscreenCount: 0,
    totalCount: currentRefs.length, currentRefs,
    obstructions: [], dialogs: [], crossOriginIframes: [],
  };
}

type Overrides = Partial<Pick<BrowserBackend, "fillByRef" | "clickByRef" | "clickByText">>;

function fakeManager(refs: DurableRef[], over: Overrides = {}): { manager: BrowserBackend; clickTextCalls: string[] } {
  const clickTextCalls: string[] = [];
  const clickByText = async (text: string): Promise<InteractionResult> => {
    clickTextCalls.push(text);
    return over.clickByText ? over.clickByText(text) : fail(`no clickable element matching text "${text}"`);
  };
  const manager = {
    getCurrentUrl: () => "https://example.com",
    // A repeat snapshot() is a diff — greping it for a stable ref finds nothing.
    snapshot: async () => DIFF_SNAPSHOT,
    observe: async () => makeObs(refs),
    fillByRef: over.fillByRef ?? (async (id: number) => pass(`[${id}] fill via role/name`)),
    clickByRef: over.clickByRef ?? (async (id: number) => pass(`[${id}] click via role/name`)),
    clickByText,
  } as unknown as BrowserBackend;
  return { manager, clickTextCalls };
}

describe("handleAct — resolves against observe().currentRefs, not snapshot()'s diff", () => {
  it("fills a stable input via its ref even though snapshot() is a diff", async () => {
    const { manager } = fakeManager([ref(42, "textbox", "Email address")]);
    const r = await handleAct(manager, { text: "fill email with hi@example.com" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Filled ref [42]");
    expect(r.content).toContain("hi@example.com");
  });

  it("clicks a stable button via its ref even though snapshot() is a diff", async () => {
    const { manager } = fakeManager([ref(7, "button", "Save changes")]);
    const r = await handleAct(manager, { text: "click the save button" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Clicked ref [7]");
  });

  it("matches a text input by its type when the accessible name is empty", async () => {
    const { manager } = fakeManager([ref(3, "textbox", "", { type: "email" })]);
    const r = await handleAct(manager, { text: "fill email with a@b.co" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Filled ref [3]");
  });
});

describe("handleAct — clickByText fallback", () => {
  it("falls back to clickByText when no ref matches, and reports the success", async () => {
    const { manager, clickTextCalls } = fakeManager(
      [ref(7, "button", "Save")],
      { clickByText: async () => pass("clicked via visible text") },
    );
    const r = await handleAct(manager, { text: "click the checkout button" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Clicked text "checkout"');
    expect(clickTextCalls).toEqual(["checkout"]);
  });

  it("surfaces the clickByText not-found as isError when nothing matches", async () => {
    const { manager, clickTextCalls } = fakeManager([ref(7, "button", "Save")]);
    const r = await handleAct(manager, { text: "click the checkout button" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Could not click text "checkout"');
    expect(clickTextCalls).toEqual(["checkout"]);
  });
});

describe("handleAct — InteractionResult.ok propagates to isError", () => {
  it("fill lands as a success result", async () => {
    const { manager } = fakeManager([ref(5, "textbox", "email")]);
    const r = await handleAct(manager, { text: "fill email with cats" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Filled ref [5]");
  });

  it("fill returns isError when fillByRef fails every strategy", async () => {
    const { manager } = fakeManager(
      [ref(5, "textbox", "email")],
      { fillByRef: async () => fail("[5] input — all resolution strategies failed. Re-observe the page.") },
    );
    const r = await handleAct(manager, { text: "fill email with cats" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Failed to fill");
  });

  it("click returns isError when clickByRef fails every strategy", async () => {
    const { manager } = fakeManager(
      [ref(7, "button", "login")],
      { clickByRef: async () => fail("[7] button — all resolution strategies failed. Re-observe the page.") },
    );
    const r = await handleAct(manager, { text: "click the login button" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Failed to click");
  });
});

describe("handleAct — co-drive preemption (USER_TOOK_WHEEL)", () => {
  it("stamps metadata.userActive when the backend refused because the human is driving", async () => {
    const { manager } = fakeManager(
      [ref(7, "button", "login")],
      { clickByRef: async () => fail(USER_TOOK_WHEEL) },
    );
    const r = await handleAct(manager, { text: "click the login button" });
    expect(r.metadata?.userActive).toBe(true);
  });
});

describe("handleAct — click role-fallback and empty-needle guard", () => {
  it("clicks an icon button by ref via the non-input fallback when its role isn't a click-role", async () => {
    // <div onclick aria-label="Close"> → role "", accessible name "Close", no
    // visible text. Not in CLICK_ROLES, and clickByText can't reach it. The
    // non-input name fallback must click it by ref.
    const { manager, clickTextCalls } = fakeManager([ref(9, "", "Close dialog")]);
    const r = await handleAct(manager, { text: "click close" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Clicked ref [9]");
    expect(clickTextCalls).toEqual([]); // resolved by ref, never fell to text
  });

  it("does NOT fall back to an input element for a click", async () => {
    // The fallback excludes FILL_ROLES so a click never lands on a textbox.
    const { manager, clickTextCalls } = fakeManager([ref(4, "textbox", "search close")]);
    const r = await handleAct(manager, { text: "click close" });
    expect(r.content).not.toContain("Clicked ref [4]");
    expect(clickTextCalls).toEqual(["close"]); // no ref matched → text fallback
  });

  it("errors on a targetless click instead of clicking an arbitrary element", async () => {
    const { manager, clickTextCalls } = fakeManager([ref(7, "button", "Save")]);
    const r = await handleAct(manager, { text: "click the button" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Say what to click");
    expect(clickTextCalls).toEqual([]); // never reached clickByText("")
  });
});
