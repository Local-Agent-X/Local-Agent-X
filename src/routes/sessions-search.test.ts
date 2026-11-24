// GET /api/sessions/search: which chats a text search returns, and what of each.
import { describe, expect, it } from "vitest";
import { searchSessions } from "./sessions.js";

type Store = Parameters<typeof searchSessions>[0];
interface FakeChat { id: string; title: string; messages: Array<{ role: string; content: unknown }>; removedAt?: number }

function storeOf(chats: FakeChat[]): Store & { loaded: string[] } {
  const loaded: string[] = [];
  return {
    loaded,
    list: () => chats.map((c) => ({ id: c.id, title: c.title, updatedAt: 100, ...(c.removedAt !== undefined ? { removedAt: c.removedAt } : {}) })),
    load: (id: string) => {
      loaded.push(id);
      const chat = chats.find((c) => c.id === id);
      return chat ? { title: chat.title, messages: chat.messages } : null;
    },
  } as unknown as Store & { loaded: string[] };
}

const chat = (id: string, ...texts: string[]): FakeChat =>
  ({ id, title: `chat ${id}`, messages: texts.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content })) });

describe("searchSessions", () => {
  it("returns the chats that contain the text, with where and a snippet around it", () => {
    const hits = searchSessions(storeOf([chat("a", "nothing here", "The Cage blocks loopback"), chat("b", "unrelated")]), "cage");
    expect(hits).toEqual([{ sessionId: "a", title: "chat a", matches: [{ role: "assistant", snippet: "The Cage blocks loopback", index: 1 }] }]);
  });

  it("cuts a snippet to 50 characters before the match and 100 after it", () => {
    const text = "x".repeat(200) + "needle" + "y".repeat(200);
    const [hit] = searchSessions(storeOf([chat("a", text)]), "needle");
    expect(hit!.matches[0]!.snippet).toBe("x".repeat(50) + "needle" + "y".repeat(100));
  });

  it("keeps at most five matches a chat, and skips a message whose content is not text", () => {
    const many = chat("a", ...Array.from({ length: 8 }, (_, i) => `needle ${i}`));
    many.messages.push({ role: "user", content: [{ type: "text", text: "needle in parts" }] });
    const [hit] = searchSessions(storeOf([many]), "needle");
    expect(hit!.matches.map((m) => m.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("leaves out a chat the user deleted and a hidden system session, without loading them", () => {
    const store = storeOf([{ ...chat("gone", "needle"), removedAt: 200 }, chat("cron-nightly", "needle"), chat("kept", "needle")]);
    expect(searchSessions(store, "needle").map((h) => h.sessionId)).toEqual(["kept"]);
    expect(store.loaded).toEqual(["kept"]);
  });

  it("stops at twenty chats, and scans no more than the first hundred", () => {
    const hits = searchSessions(storeOf(Array.from({ length: 30 }, (_, i) => chat(`c${i}`, "needle"))), "needle");
    expect(hits).toHaveLength(20);

    const store = storeOf([...Array.from({ length: 100 }, (_, i) => chat(`quiet${i}`, "nothing")), chat("late", "needle")]);
    expect(searchSessions(store, "needle")).toEqual([]);
    expect(store.loaded).toHaveLength(100);
  });
});
