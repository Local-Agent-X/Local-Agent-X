import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionHelpers } from "./session-helpers.js";
import type { Session } from "../types.js";
import type { MemoryIndex, SessionStore } from "../memory/index.js";

// ── Shared-state ownership audit (chunk C6) ─────────────────────────────
// Who owns a session transcript's bytes?
//
// SessionStore.save is a FULL atomic rewrite of the session's jsonl
// (memory/session-message-log.ts:writeSessionLog), so every writer is a
// whole-file last-writer-wins writer. session-helpers.ts owns the two
// mechanisms that make that safe: an in-memory `sessions` cache (one Session
// OBJECT per id, so concurrent mutators append to the same array) and a
// per-session `writeQueues` serializer, whose doc comment states the
// invariant: "any reader that consumes session.messages as the committed
// transcript MUST await flushSession(id) first."
//
// These are characterizations, not blessings. They pin what the code does
// TODAY so a deliberate fix flips them.

/** Disk-backed enough to be honest: a real read-modify-write round trip. */
function makeStore(): SessionStore & { disk: Map<string, string> } {
  const disk = new Map<string, string>();
  const store = {
    disk,
    save(session: Session) { disk.set(session.id, JSON.stringify(session)); },
    load(id: string): Session | null {
      const raw = disk.get(id);
      return raw ? (JSON.parse(raw) as Session) : null;
    },
  };
  return store as unknown as SessionStore & { disk: Map<string, string> };
}

const memoryIndex = { markDirty() {}, async indexChunks() {} } as unknown as MemoryIndex;

let dataDir: string;

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "lax-session-owner-")); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

function helpers(maxCached = 200) {
  const sessionStore = makeStore();
  return { sessionStore, ...createSessionHelpers({ sessionStore, memoryIndex, dataDir, maxCached }) };
}

describe("session-helpers: the queued-write invariant it documents", () => {
  it("serializes concurrent saveSession calls for one session", async () => {
    const h = helpers();
    const s = h.getOrCreateSession("s1");

    s.messages.push({ role: "user", content: "one" } as never);
    const first = h.saveSession(s);
    s.messages.push({ role: "assistant", content: "two" } as never);
    const second = h.saveSession(s);

    await Promise.all([first, second]);
    const onDisk = h.sessionStore.load("s1")!;
    expect(onDisk.messages).toHaveLength(2);
  });

  it("flushSession awaits the queued write, so a later reader sees committed bytes", async () => {
    const h = helpers();
    const s = h.getOrCreateSession("s2");
    s.messages.push({ role: "user", content: "hi" } as never);
    void h.saveSession(s); // fire-and-forget, as callers are permitted to

    await h.flushSession("s2");
    expect(h.sessionStore.load("s2")!.messages).toHaveLength(1);
  });
});

describe("CHARACTERIZATION — a disk-side read-modify-write is not owned", () => {
  // The shape used by server/handler-events-agent-result.ts:147 (agent
  // completion row injected into the parent chat) and server/index.ts:78
  // (the session-bridge persister): sessionStore.load -> push ->
  // sessionStore.save, with NO flushSession, NO turn guard, and NOT through
  // the `sessions` cache. Both siblings that mutate a transcript from a route
  // (routes/chat/retract-route.ts, routes/chat/compact-route.ts) DO await
  // flushSession and DO mutate the cached object. This pins what the
  // odd-one-out shape costs.
  it("a row appended to a disk-loaded copy is erased by the next cached-object save", async () => {
    const h = helpers();

    // A chat turn is live: it holds the CACHED object and has persisted once.
    const live = h.getOrCreateSession("s3");
    live.messages.push({ role: "user", content: "spawn an agent" } as never);
    await h.saveSession(live);

    // An out-of-band writer (agent result / bridge persister) loads from disk,
    // appends its row, and saves. The row is durable at this instant.
    const copy = h.sessionStore.load("s3")!;
    copy.messages.push({ role: "assistant", content: "[Agent failed]" } as never);
    h.sessionStore.save(copy);
    expect(h.sessionStore.load("s3")!.messages).toHaveLength(2);

    // The live turn ends and persists from its own object, which never saw
    // the row (canonical-run.ts:persistTurnState does
    // `session.messages = [...session.messages, ...newRows]`).
    live.messages.push({ role: "assistant", content: "done" } as never);
    await h.saveSession(live);

    const final = h.sessionStore.load("s3")!;
    expect(final.messages.map((m) => m.content)).toEqual(["spawn an agent", "done"]);
    // The out-of-band row is gone from the transcript.
    expect(final.messages.some((m) => m.content === "[Agent failed]")).toBe(false);
  });

  it("the disk-side writer also never lands in the cache, so cached readers never see its row", async () => {
    const h = helpers();
    const cached = h.getOrCreateSession("s4");
    cached.messages.push({ role: "user", content: "q" } as never);
    await h.saveSession(cached);

    const copy = h.sessionStore.load("s4")!;
    copy.messages.push({ role: "assistant", content: "out-of-band" } as never);
    h.sessionStore.save(copy);

    // flushSession is a no-op (nothing queued) and the cache still holds the
    // pre-row object, so the very next turn prepares from a transcript that
    // is missing a row that IS on disk.
    await h.flushSession("s4");
    expect(h.getOrCreateSession("s4").messages).toHaveLength(1);
  });
});

describe("CHARACTERIZATION — the LRU bound is enforced by one writer, not three", () => {
  // getOrCreateSession trims to maxCached on both of its insert paths
  // (session-helpers.ts:58 and :61). saveSession's `sessions.set` (:67) is the
  // third writer of the same map and applies no trim.
  it("saveSession can push the cache past maxCached", async () => {
    const h = helpers(2);
    h.getOrCreateSession("a");
    h.getOrCreateSession("b");
    expect(h.sessions.size).toBe(2);

    // Evicted by insertion of a third; then re-inserted by a save.
    h.getOrCreateSession("c");
    expect(h.sessions.size).toBe(2);
    await h.saveSession({ id: "a", title: "t", messages: [], createdAt: 1, updatedAt: 1 });
    expect(h.sessions.size).toBe(3);
  });

  it("eviction mid-turn mints a SECOND live object for one session id", () => {
    const h = helpers(1);
    const turnObject = h.getOrCreateSession("live");
    turnObject.messages.push({ role: "user", content: "turn in flight" } as never);

    h.getOrCreateSession("other"); // evicts "live" from the cache

    // A second reader now reloads "live" from disk (empty here) and gets a
    // DIFFERENT object than the in-flight turn is still mutating. Neither
    // writer can see the other's appends, and whichever saves last wins the
    // whole file.
    const reloaded = h.getOrCreateSession("live");
    expect(reloaded).not.toBe(turnObject);
    expect(reloaded.messages).toHaveLength(0);
    expect(turnObject.messages).toHaveLength(1);
  });
});
