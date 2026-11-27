// The right panel's Android tab (public/js/android-tab.js): it shows the
// device an agent is driving, keeps that device's feed alive while it is open,
// and opens itself the first time the agent of the chat on screen uses the
// `android` tool. Before, the agent drove a phone or a pop-up emulator and the
// tab built for watching it stayed closed and empty (2026-11-26).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../public/js/android-tab.js"), "utf8");
const viewSrc = readFileSync(join(here, "../public/js/android-view-client.js"), "utf8");

type Device = { serial: string; state: string; model?: string; heldBy?: { sessionId: string; title: string } };
type Tab = { onTabShown(): void; onTabHidden(): void; refresh(): Promise<void> };
type ChatEvent = { type: string; toolName?: string };

function load(devices: Device[], chat: { id: string } | null = { id: "chat-a" }) {
  const fetched: string[] = [];
  const switched: string[] = [];
  let onEvent: (sessionId: string, entry: unknown, ev: ChatEvent | null) => void = () => {};
  let shownSerial: (() => string | null) | undefined;
  const elements = new Map<string, { textContent?: string; disabled?: boolean }>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id)!;
  };
  const page = {
    window: { ChatStreamStore: { subscribeAll: (cb: typeof onEvent) => { onEvent = cb; } } } as { laxAndroidTab?: Tab; ChatStreamStore: unknown },
    ChatStreamStore: { subscribeAll: (cb: typeof onEvent) => { onEvent = cb; } },
    document: { getElementById: element },
    fetch: async (url: string) => { fetched.push(url); return { json: async () => ({ devices }) }; },
    setInterval: () => 1,
    clearInterval: () => {},
    encodeURIComponent,
    activeChat: chat,
    agentFeedsOpen: false,
    sidePanelTab: "agents",
    toggleAgentFeeds() { page.agentFeedsOpen = !page.agentFeedsOpen; },
    switchSidePanelTab(tab: string) { page.sidePanelTab = tab; switched.push(tab); },
    attachAndroidView(_canvas: unknown, serial: () => string | null) { shownSerial = serial; return () => {}; },
  };
  // eslint-disable-next-line no-new-func
  new Function("page", `with (page) {\n${src}\n}`)(page);
  return {
    page, fetched, switched, element,
    tab: page.window.laxAndroidTab!,
    emit: (sessionId: string, ev: ChatEvent | null) => onEvent(sessionId, {}, ev),
    shownSerial: () => shownSerial?.() ?? null,
  };
}

const PHONE: Device = { serial: "R3GLA04C0JK", state: "device", model: "SM_S948U1" };
const EMULATOR: Device = { serial: "emulator-5554", state: "device" };

describe("which device the tab shows", () => {
  it("the one an agent is driving, over one that is merely connected", async () => {
    const t = load([EMULATOR, { ...PHONE, heldBy: { sessionId: "chat-a", title: "Label Check" } }]);
    t.tab.onTabShown();
    await t.tab.refresh();
    expect(t.shownSerial()).toBe("R3GLA04C0JK");
    expect(t.element("android-status").textContent).toContain("this chat’s agent is using it");
  });

  it("the first connected device when no agent has one", async () => {
    const t = load([{ serial: "offline-1", state: "offline" }, EMULATOR, PHONE]);
    await t.tab.refresh();
    expect(t.element("android-status").textContent).toContain("emulator-5554");
  });

  it("asks for that device's feed at once, then with every poll", async () => {
    const t = load([PHONE]);
    await t.tab.refresh();
    expect(t.fetched).toEqual(["/api/android/devices", "/api/android/devices?view=R3GLA04C0JK"]);
    await t.tab.refresh();
    expect(t.fetched.slice(2)).toEqual(["/api/android/devices?view=R3GLA04C0JK"]);
  });

  it("offers Stop for an emulator and not for a phone", async () => {
    const phone = load([PHONE]);
    await phone.tab.refresh();
    expect(phone.element("android-stop-btn").disabled).toBe(true);
    const emulator = load([EMULATOR]);
    await emulator.tab.refresh();
    expect(emulator.element("android-stop-btn").disabled).toBe(false);
    expect(emulator.element("android-start-btn").disabled).toBe(true);
  });

  it("says so when nothing is connected", async () => {
    const t = load([]);
    await t.tab.refresh();
    expect(t.element("android-status").textContent).toBe("No device connected.");
    expect(t.element("android-start-btn").disabled).toBe(false);
  });

  // A phone whose USB link kept dropping read as "No device connected" while
  // the owner looked at it plugged in (2026-11-26).
  it("names a phone that dropped off, and when", async () => {
    const devices: Device[] = [PHONE];
    const t = load(devices);
    await t.tab.refresh();
    devices.length = 0;
    await t.tab.refresh();
    const said = t.element("android-status").textContent ?? "";
    expect(said).toMatch(/^SM-S948U1 \(R3GLA04C0JK\) dropped off at .+\. Check the cable/);
  });

  it("says what to do with a phone that is plugged in but not usable", async () => {
    const waiting = load([{ ...PHONE, state: "unauthorized" }]);
    await waiting.tab.refresh();
    expect(waiting.element("android-status").textContent).toContain("has not allowed USB debugging: unlock it and tap Allow");
    const stuck = load([{ ...PHONE, state: "offline" }]);
    await stuck.tab.refresh();
    expect(stuck.element("android-status").textContent).toContain("not answering: unplug it and plug it back in");
  });

  it("an emulator that was stopped is not reported as dropped", async () => {
    const devices: Device[] = [EMULATOR];
    const t = load(devices);
    await t.tab.refresh();
    devices.length = 0;
    await t.tab.refresh();
    expect(t.element("android-status").textContent).toBe("No device connected.");
  });
});

describe("the tab opens itself when the chat's agent uses the android tool", () => {
  const use: ChatEvent = { type: "tool_start", toolName: "android" };

  it("opens a closed panel on the Android tab", () => {
    const t = load([PHONE]);
    t.emit("chat-a", use);
    expect(t.page.agentFeedsOpen).toBe(true);
    expect(t.switched).toEqual(["android"]);
  });

  it("once per chat: a user who closed it is not overruled by the next tap", () => {
    const t = load([PHONE]);
    t.emit("chat-a", use);
    t.page.sidePanelTab = "agents";
    t.emit("chat-a", use);
    expect(t.switched).toEqual(["android"]);
  });

  it("not for another chat's agent, another tool, or an event that is not a tool starting", () => {
    const t = load([PHONE]);
    t.emit("chat-b", use);
    t.emit("chat-a", { type: "tool_start", toolName: "browser" });
    t.emit("chat-a", { type: "tool_end", toolName: "android" });
    t.emit("chat-a", null);
    expect(t.switched).toEqual([]);
    expect(t.page.agentFeedsOpen).toBe(false);
  });

  it("leaves an open panel open and only turns it", () => {
    const t = load([PHONE]);
    t.page.agentFeedsOpen = true;
    t.emit("chat-a", use);
    expect(t.page.agentFeedsOpen).toBe(true);
    expect(t.switched).toEqual(["android"]);
  });
});

describe("the canvas (android-view-client.js)", () => {
  function attach(serial: (() => string | null) | string | undefined) {
    let onFrame: (frame: { viewId: string; pngBase64: string }) => void = () => {};
    const drawn: string[] = [];
    class FakeImage { onload: (() => void) | null = null; set src(v: string) { drawn.push(v); } }
    const page = {
      window: { desktop: { android: { onFrame: (cb: typeof onFrame) => { onFrame = cb; } } } },
      Image: FakeImage,
    };
    // eslint-disable-next-line no-new-func
    const attachAndroidView = new Function("page", `with (page) {\n${viewSrc}\nreturn attachAndroidView;\n}`)(page);
    attachAndroidView({ getContext: () => ({ drawImage() {} }) }, serial);
    return { frame: (viewId: string) => onFrame({ viewId, pngBase64: viewId }), drawn };
  }

  it("draws only the device the tab is showing, as that changes", () => {
    let showing: string | null = "R3GLA04C0JK";
    const v = attach(() => showing);
    v.frame("emulator-5554");
    v.frame("R3GLA04C0JK");
    showing = "emulator-5554";
    v.frame("emulator-5554");
    expect(v.drawn).toEqual(["data:image/png;base64,R3GLA04C0JK", "data:image/png;base64,emulator-5554"]);
  });

  it("draws every frame when no device is chosen yet", () => {
    const v = attach(() => null);
    v.frame("emulator-5554");
    expect(v.drawn).toHaveLength(1);
  });
});
