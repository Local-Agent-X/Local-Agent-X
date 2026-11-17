// A human check is handed to the user and the chat picks the task back up
// once it is gone (the Purell reorder stopped at Amazon's "I am human" box and
// was left for the user to finish later, 2026-11-17).
import { describe, it, expect, beforeEach, vi } from "vitest";

const { page, handled, alerts, taps, inbox } = vi.hoisted(() => ({
  page: { open: true },
  taps: [] as Array<Record<string, unknown>>,
  inbox: { posted: [] as Array<Record<string, unknown>>, resolved: 0 },
  handled: [] as Array<{ sessionId: string; message: string }>,
  alerts: [] as Array<{ sessionId: string; site: string }>,
}));
vi.mock("../../browser/index.js", () => ({
  getBrowserManager: () => ({
    observe: async () => ({
      title: "Amazon.com",
      crossOriginIframes: [],
      currentRefs: [{ role: "checkbox", name: "I am human", state: { checked: !page.open } }],
    }),
    screenshot: async () => ({ text: "shot", image: { mime: "image/jpeg", b64: "QUJD", path: "Z:/nowhere/shot.png", question: "" } }),
    relayInput: async (input: Record<string, unknown>) => { taps.push(input); },
  }),
  withBrowserLock: async (_s: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../../chat-ws/chat-handler.js", () => ({
  getChatHandler: () => (sessionId: string, message: string) => { handled.push({ sessionId, message }); },
}));
vi.mock("../../inbox/index.js", () => ({
  postToInbox: (input: Record<string, unknown>) => { inbox.posted.push(input); return null; },
  resolveInboxWhere: () => { inbox.resolved += 1; return 1; },
}));
vi.mock("../../session/turn-lock.js", () => ({ hasActiveTurn: () => false, onTurnRelease: () => {} }));

import { handOffHumanCheck, humanCheckPicture, relayHumanCheck, setHumanCheckAlert, _pollHumanCheckForTest, _resetHumanCheckHandoffForTest, _setHumanCheckClockForTest, GIVE_UP_MS, HELD_TOO_LONG_MS } from "./human-check-handoff.js";
import { blocked, ok } from "../result-helpers.js";
import { HUMAN_VERIFICATION_MESSAGE, HUMAN_VERIFICATION_RECOVERY } from "../../browser/human-verification.js";

const CHAT = "mobile-abc";
const URL_ = "https://www.amazon.com/checkpoint/continue?token=x";
const refusal = () => blocked(HUMAN_VERIFICATION_MESSAGE, { layer: "browser-human-verification", browserStatus: "human-verification-required", recovery: HUMAN_VERIFICATION_RECOVERY });

beforeEach(() => {
  _resetHumanCheckHandoffForTest();
  handled.length = 0; alerts.length = 0; taps.length = 0; page.open = true;
  inbox.posted.length = 0; inbox.resolved = 0;
  setHumanCheckAlert((sessionId, site) => alerts.push({ sessionId, site }));
});

describe("human check handoff", () => {
  it("alerts the user once, and tells the agent to wait instead of retrying", async () => {
    const first = handOffHumanCheck(refusal(), CHAT, URL_, false);
    handOffHumanCheck(refusal(), CHAT, URL_, false);
    expect(alerts).toEqual([{ sessionId: CHAT, site: "amazon.com" }]);
    expect(first.content).toContain("HANDED TO THE USER");
    expect(first.content).toContain("Do not retry");
    expect(first.status === "blocked" && first.metadata.recovery).toContain("the app tells you when the check is gone");
  });

  it("hands off a check seen in a page snapshot, not only the gate's refusal", () => {
    const snap = ok(`Page: Amazon.com — ${URL_}\n[444]<checkbox type=checkbox>I am human</checkbox> {unchecked}`);
    expect(handOffHumanCheck(snap, CHAT, URL_, false).content).toContain("HANDED TO THE USER");
    expect(alerts).toHaveLength(1);
  });

  it("wakes the chat once the check is gone, and not while it is open", async () => {
    handOffHumanCheck(refusal(), CHAT, URL_, false);
    await _pollHumanCheckForTest(CHAT);
    expect(handled).toHaveLength(0);
    page.open = false;
    await _pollHumanCheckForTest(CHAT);
    expect(handled).toHaveLength(1);
    expect(handled[0].sessionId).toBe(CHAT);
    expect(handled[0].message).toContain("not typed by the user");
    expect(handled[0].message).toContain("carry on with what the user asked");
    await _pollHumanCheckForTest(CHAT);
    expect(handled).toHaveLength(1);
  });

  it("gives up after the wait runs out, waking nothing", async () => {
    let t = 1_000;
    _setHumanCheckClockForTest(() => t);
    handOffHumanCheck(refusal(), CHAT, URL_, false);
    t += GIVE_UP_MS + 1;
    page.open = false;
    await _pollHumanCheckForTest(CHAT);
    expect(handled).toHaveLength(0);
  });

  it("leaves an unattended run, a sub-agent and an ordinary page alone", () => {
    const r = refusal();
    expect(handOffHumanCheck(r, CHAT, URL_, true)).toBe(r);
    expect(handOffHumanCheck(r, "agent-1", URL_, false)).toBe(r);
    expect(handOffHumanCheck(r, "cron-1", URL_, false)).toBe(r);
    const plain = ok("Page: Your Orders — https://www.amazon.com/\n[1]<link>Buy it again</link>");
    expect(handOffHumanCheck(plain, CHAT, URL_, false)).toBe(plain);
    expect(alerts).toHaveLength(0);
  });

  it("says nothing about a phone when no alert is wired", () => {
    setHumanCheckAlert(null);
    const r = handOffHumanCheck(refusal(), CHAT, URL_, false);
    expect(r.content).not.toContain("phone");
  });

  it("by default rings the phone through the inbox with a link that opens the page, and closes it after", async () => {
    _resetHumanCheckHandoffForTest();
    inbox.posted.length = 0; inbox.resolved = 0;
    handOffHumanCheck(refusal(), CHAT, URL_, false);
    expect(inbox.posted).toHaveLength(1);
    expect(inbox.posted[0]).toMatchObject({ kind: "agent-message", needsYou: true, key: "human-check:" + CHAT, link: { sessionId: CHAT, url: "/human-check/" + CHAT } });
    page.open = false;
    await _pollHumanCheckForTest(CHAT);
    expect(inbox.resolved).toBe(1);
  });

  it("shows the page and relays input only while a check is handed off", async () => {
    expect(await humanCheckPicture(CHAT)).toEqual({ open: false });
    expect(await relayHumanCheck(CHAT, { kind: "tap", x: 0.5, y: 0.5 })).toBe(false);
    handOffHumanCheck(refusal(), CHAT, URL_, false);
    expect(await humanCheckPicture(CHAT)).toEqual({ open: true, site: "amazon.com", mime: "image/jpeg", b64: "QUJD" });
    expect(await relayHumanCheck(CHAT, { kind: "tap", x: 0.25, y: 0.75 })).toBe(true);
    expect(await relayHumanCheck(CHAT, { kind: "text", text: "XK4P" })).toBe(true);
    expect(taps).toEqual([{ kind: "tap", x: 0.25, y: 0.75 }, { kind: "text", text: "XK4P" }]);
  });

  // A press-and-hold whose release never arrives (the phone app closed
  // mid-hold) must not leave the page's button held down.
  it("lets go of a press the phone never released", async () => {
    vi.useFakeTimers();
    try {
      handOffHumanCheck(refusal(), CHAT, URL_, false);
      await relayHumanCheck(CHAT, { kind: "press", x: 0.5, y: 0.6 });
      await vi.advanceTimersByTimeAsync(HELD_TOO_LONG_MS + 10);
      expect(taps.at(-1)).toEqual({ kind: "release", x: 0.5, y: 0.6 });
      taps.length = 0;
      await relayHumanCheck(CHAT, { kind: "press", x: 0.5, y: 0.6 });
      await relayHumanCheck(CHAT, { kind: "release", x: 0.7, y: 0.6 });
      await vi.advanceTimersByTimeAsync(HELD_TOO_LONG_MS + 10);
      expect(taps.map((t) => t.kind)).toEqual(["press", "release"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
