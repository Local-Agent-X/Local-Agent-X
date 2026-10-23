/**
 * A code session stays a code session across a restart (session/mode.ts): the
 * mode rides the session log's meta row and the sessions-list metadata, which
 * is how the sidebar puts each session on its side.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session } from "../types.js";
import { readSessionLog, writeSessionLog } from "./session-message-log.js";
import { metadataOf } from "./session-metadata-cache.js";

function session(over: Partial<Session> = {}): Session {
  return { id: "chat-mode-1", title: "t", messages: [{ role: "user", content: "hi" }], createdAt: 1, updatedAt: 2, ...over };
}

describe("a session's mode, saved and read back", () => {
  it("a code session reloads as a code session", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-session-mode-"));
    writeSessionLog(dir, session({ mode: "code" }));
    expect(readSessionLog(dir, "chat-mode-1")?.mode).toBe("code");
  });

  it("a chat writes no mode and reloads as a chat", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-session-mode-"));
    writeSessionLog(dir, session());
    expect(readSessionLog(dir, "chat-mode-1")?.mode).toBeUndefined();
  });

  it("the sessions list marks code sessions, App IDE ones included", () => {
    expect(metadataOf(session({ mode: "code" })).mode).toBe("code");
    expect(metadataOf(session({ id: "ide-calendar" })).mode).toBe("code");
    expect(metadataOf(session()).mode).toBeUndefined();
  });
});
