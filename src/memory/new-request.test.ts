import { describe, expect, it } from "vitest";
import { NEW_REQUEST_GAP_MS, startsNewRequest } from "./manager.js";

const talk = [{ role: "user" }, { role: "assistant" }];

describe("a message starts a new request (and may recall other chats)", () => {
  it("on a chat's first message", () => {
    expect(startsNewRequest([], undefined)).toBe(true);
    expect(startsNewRequest([{ role: "user" }], undefined)).toBe(true);
  });

  it("after the chat sat quiet, on any channel: a WhatsApp thread that never ends included", () => {
    expect(startsNewRequest(talk, NEW_REQUEST_GAP_MS)).toBe(true);
    expect(startsNewRequest(talk, 6 * 60 * 60 * 1000)).toBe(true);
  });

  it("not inside an active exchange: that is the cross-conversation bleed the narrowing fixed", () => {
    expect(startsNewRequest(talk, 2 * 60 * 1000)).toBe(false);
    expect(startsNewRequest(talk, NEW_REQUEST_GAP_MS - 1)).toBe(false);
    expect(startsNewRequest(talk, undefined)).toBe(false);
  });
});

describe("how long a chat sat quiet", () => {
  it("is the time since its last turn ended, and nothing for a new chat", async () => {
    const { quietForMs } = await import("./manager.js");
    expect(quietForMs({ messages: [], updatedAt: 0 }, 1_000)).toBeUndefined();
    expect(quietForMs({ messages: [{}], updatedAt: 1_000 }, 61_000)).toBe(60_000);
    expect(quietForMs({ messages: [{}], updatedAt: 5_000 }, 1_000)).toBe(0);
  });
});
