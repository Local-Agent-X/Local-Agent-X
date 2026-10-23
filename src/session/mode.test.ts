import { describe, expect, it } from "vitest";
import { parseChatMode, sessionModeOf } from "./mode.js";

describe("parseChatMode", () => {
  it("reads chat and code, and nothing else", () => {
    expect(parseChatMode("code")).toBe("code");
    expect(parseChatMode("chat")).toBe("chat");
    for (const v of [undefined, null, "", "CODE", "ide", 1, {}]) expect(parseChatMode(v)).toBeUndefined();
  });
});

describe("sessionModeOf", () => {
  it("a session with no stored mode is a chat, as every session before modes was", () => {
    expect(sessionModeOf({ id: "chat-abc" })).toBe("chat");
  });

  it("reads the stored mode", () => {
    expect(sessionModeOf({ id: "chat-abc", mode: "code" })).toBe("code");
  });

  // The App IDE's chats are code sessions by their id, including ones created
  // before modes existed.
  it("an App IDE session is a code session by its id", () => {
    expect(sessionModeOf({ id: "ide-calendar" })).toBe("code");
    expect(sessionModeOf({ id: "ide-calendar", mode: "chat" })).toBe("code");
  });
});
