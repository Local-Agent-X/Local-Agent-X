// A saved chat that the lists show tells every device to re-read its chat list;
// a background session's save, or a removed chat's, tells no one.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionHelpers } from "./session-helpers.js";
import type { Session } from "../types.js";
import type { MemoryIndex, SessionStore } from "../memory/index.js";

const store = { save() {}, load: () => null } as unknown as SessionStore;
const memoryIndex = { markDirty() {}, async indexChunksIdempotent() { return { added: 0 }; } } as unknown as MemoryIndex;

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "lax-list-announce-")); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

function saveAndCount(session: Session): Promise<number> {
  const announce = vi.fn();
  const h = createSessionHelpers({ sessionStore: store, memoryIndex, dataDir, maxCached: 10, onListedChatSaved: announce });
  return h.saveSession(session).then(() => announce.mock.calls.length);
}

const chat = (id: string, extra: Partial<Session> = {}): Session =>
  ({ id, title: "t", messages: [], createdAt: 1, updatedAt: 2, ...extra });

describe("session-helpers: the chat-list announcement", () => {
  it("announces a listed chat's save, an empty new one included", async () => {
    expect(await saveAndCount(chat("mobile-abc-123"))).toBe(1);
  });

  it("stays quiet for a session the lists hide", async () => {
    expect(await saveAndCount(chat("cron-nightly"))).toBe(0);
    expect(await saveAndCount(chat("dream-1"))).toBe(0);
  });

  it("stays quiet for a chat removed from the lists", async () => {
    expect(await saveAndCount(chat("s1", { removedAt: 5, updatedAt: 2 }))).toBe(0);
  });
});
