// A message the app sends while the chat's turn is running waits for that turn
// and is then sent. Until 2026-11-27 it was lost: the wait hooked the turn's
// release from inside that release, which had already fired.
import { describe, it, expect, afterEach } from "vitest";
import { setChatHandler } from "./chat-handler.js";
import { sendAppMessageWhenIdle } from "./app-message.js";
import { acquireTurn, releaseTurn } from "../session/turn-lock.js";

const CHAT = "chat-app-message";
const nextMacrotask = () => new Promise((r) => setTimeout(r, 10));
afterEach(() => releaseTurn(CHAT));

describe("an app message asked for during a turn", () => {
  it("is sent once the turn ends, composed then", async () => {
    const sent: string[] = [];
    let ended = 0;
    setChatHandler(async (_sessionId, message) => { sent.push(message); });
    acquireTurn(CHAT, new AbortController());
    let state = "asked";
    expect(sendAppMessageWhenIdle(CHAT, () => `a build ended (${state})`, () => { ended++; })).toBe(true);
    await nextMacrotask();
    expect(sent).toEqual([]);
    state = "sent";
    releaseTurn(CHAT);
    await nextMacrotask();
    expect(sent).toEqual(["a build ended (sent)"]);
    expect(ended).toBe(1);
  });

  it("is dropped, and says so, when there is nothing to send any more", async () => {
    const sent: string[] = [];
    let ended = 0;
    setChatHandler(async (_sessionId, message) => { sent.push(message); });
    acquireTurn(CHAT, new AbortController());
    sendAppMessageWhenIdle(CHAT, () => null, () => { ended++; });
    releaseTurn(CHAT);
    await nextMacrotask();
    expect(sent).toEqual([]);
    expect(ended).toBe(1);
  });
});
