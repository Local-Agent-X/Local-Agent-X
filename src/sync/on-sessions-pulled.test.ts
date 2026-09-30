import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../memory/session-store.js";
import { writeSessionLog } from "../memory/session-message-log.js";
import { adoptPulledSessions } from "./on-sessions-pulled.js";
import type { Session } from "../types.js";

const universal = vi.hoisted(() => ({ index: { indexSessionTranscript: vi.fn(async () => ({ added: 1, removed: 0, unchanged: 0 })) } as { indexSessionTranscript: ReturnType<typeof vi.fn> } | null }));
vi.mock("../memory/universal-index.js", () => ({ getUniversalIndex: () => universal.index }));

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function log(dir: string, id: string, turns: number): void {
  const messages: Session["messages"] = [];
  for (let i = 0; i < turns; i++) messages.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
  writeSessionLog(dir, { id, title: `Session ${id}`, createdAt: 1, updatedAt: 1000 + turns, messages } as Session);
}

describe("a session log another machine wrote", () => {
  it("is listed by the store once adopted, and survives a restart through the journal", () => {
    root = mkdtempSync(join(tmpdir(), "lax-adopt-"));
    const store = new SessionStore(root);
    expect(store.list()).toEqual([]);
    log(join(root, "sessions"), "remote-1", 2);
    log(join(root, "sessions"), "remote-2", 1);
    store.adopt(["remote-1", "remote-2", "never-arrived"]);
    expect(store.list().map((s) => [s.id, s.messageCount])).toEqual([["remote-1", 4], ["remote-2", 2]]);
    expect(new SessionStore(root).list().map((s) => s.id).sort()).toEqual(["remote-1", "remote-2"]);
  });

  it("is adopted, marks the memory index dirty, and is indexed for cross-session search", () => {
    root = mkdtempSync(join(tmpdir(), "lax-adopt-"));
    const store = new SessionStore(root);
    log(join(root, "sessions"), "remote-1", 1);
    const memoryIndex = { markDirty: vi.fn() };
    adoptPulledSessions(["remote-1"], { sessionStore: store, memoryIndex });
    expect(store.list().map((s) => s.id)).toEqual(["remote-1"]);
    expect(memoryIndex.markDirty).toHaveBeenCalledTimes(1);
    expect(universal.index!.indexSessionTranscript).toHaveBeenCalledWith("remote-1");
  });

  it("does not need the universal index to exist", () => {
    root = mkdtempSync(join(tmpdir(), "lax-adopt-"));
    universal.index = null;
    const store = new SessionStore(root);
    log(join(root, "sessions"), "remote-1", 1);
    expect(() => adoptPulledSessions(["remote-1"], { sessionStore: store, memoryIndex: { markDirty: vi.fn() } })).not.toThrow();
  });
});
