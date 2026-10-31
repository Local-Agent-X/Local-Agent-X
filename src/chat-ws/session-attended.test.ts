// Who can answer a chat's approval card: a browser tab (any), a socket client
// subscribed to the session, the phone's projection, or a caller holding the
// `/api/chat` response. Nobody → the approval gate parks the call at once.
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { chatUnattended, holdSessionStream, sessionAttended } from "./broadcast.js";
import { subscribeSessionEvents } from "./session-event-observers.js";
import { activeChats, browserClients, clients, type ActiveChat } from "./state.js";

const fakeWs = (readyState = 1) => ({ readyState, send() {} }) as unknown as WebSocket;

afterEach(() => { clients.clear(); activeChats.clear(); });

describe("chatUnattended", () => {
  it("judges only a live turn: no turn or a done one keeps the card, a live one with nobody attached does not", () => {
    expect(chatUnattended("s-live")).toBe(false);
    activeChats.set("s-live", { sessionId: "s-live", done: false } as unknown as ActiveChat);
    expect(chatUnattended("s-live")).toBe(true);
    const release = holdSessionStream("s-live");
    expect(chatUnattended("s-live")).toBe(false);
    release();
    activeChats.set("s-live", { sessionId: "s-live", done: true } as unknown as ActiveChat);
    expect(chatUnattended("s-live")).toBe(false);
  });
});

describe("sessionAttended", () => {
  it("is false with no client, no observer and no held response", () => {
    expect(sessionAttended("s-nobody")).toBe(false);
  });

  it("an open browser tab attends every session; a closed one attends none", () => {
    const tab = fakeWs();
    browserClients.add(tab);
    clients.set(tab, new Set(["s-other"]));
    expect(sessionAttended("s-one")).toBe(true);
    clients.set(tab, new Set());
    expect(sessionAttended("s-one")).toBe(true);
    const closed = fakeWs(3);
    browserClients.add(closed);
    clients.clear();
    clients.set(closed, new Set(["s-one"]));
    expect(sessionAttended("s-one")).toBe(false);
  });

  it("a non-browser client (the phone's bridge) attends only the sessions it subscribed to", () => {
    const bridge = fakeWs();
    clients.set(bridge, new Set(["s-phone"]));
    expect(sessionAttended("s-phone")).toBe(true);
    expect(sessionAttended("s-elsewhere")).toBe(false);
  });

  it("the phone's projection attends while it observes", () => {
    const off = subscribeSessionEvents("s-proj", () => {});
    expect(sessionAttended("s-proj")).toBe(true);
    off();
    expect(sessionAttended("s-proj")).toBe(false);
  });

  it("a held response attends until every hold is released, and a release is idempotent", () => {
    const a = holdSessionStream("s-sse");
    const b = holdSessionStream("s-sse");
    expect(sessionAttended("s-sse")).toBe(true);
    a(); a();
    expect(sessionAttended("s-sse")).toBe(true);
    b();
    expect(sessionAttended("s-sse")).toBe(false);
  });
});
