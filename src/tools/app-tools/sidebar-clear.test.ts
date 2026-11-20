// sidebar_clear deletes the Conversations list the way the user's "Delete all"
// does (session/remove.ts): every chat stays on disk, and the chat that asked
// stays listed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../chat-ws/index.js", () => ({ broadcastAll: vi.fn() }));

import { sidebarClear } from "./sidebar.js";
import { bindChatRemoval, isListedChat } from "../../session/remove.js";
import { SessionStore } from "../../memory/session-store.js";
import type { Session } from "../../types.js";

let dataDir = "";
afterEach(() => { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); });

describe("sidebar_clear", () => {
  it("removes the other chats from the lists, keeps the asking chat, deletes nothing", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-sidebar-clear-"));
    const sessionStore = new SessionStore(dataDir);
    const chat = (id: string): Session => ({ id, title: id, messages: [{ role: "user", content: "hi" }], createdAt: 1, updatedAt: 1 });
    for (const id of ["chat-a", "chat-b", "chat-here"]) sessionStore.save(chat(id));
    const cache = new Map<string, Session>();
    bindChatRemoval({
      dataDir, sessionStore,
      memoryIndex: { forgetChunksAtPath: () => 0, maintenanceDb: () => ({}) as never },
      getOrCreateSession: (id) => { const s = cache.get(id) ?? sessionStore.load(id)!; cache.set(id, s); return s; },
      saveSession: async (s) => { sessionStore.save(s); },
      flushSession: async () => {},
      dropSession: (id) => { cache.delete(id); },
    });

    const r = await sidebarClear.execute({ _sessionId: "chat-here" });

    expect(r.isError).toBeFalsy();
    expect(sessionStore.list().filter(isListedChat).map((m) => m.id)).toEqual(["chat-here"]);
    for (const id of ["chat-a", "chat-b"]) expect(existsSync(join(dataDir, "sessions", `${id}.jsonl`))).toBe(true);
  });
});
