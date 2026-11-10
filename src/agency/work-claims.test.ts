import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import { locateInRepo, _resetRepoLocateCacheForTest } from "./repo-locate.js";
import {
  CHAT_IDLE_HOLD_MS, RECENT_MS, WORKER_START_GRACE_MS, findClashes, liveHolders, noteSessionOp, recordClaims, touchHolders,
  _resetWorkClaimsForTest, _setWorkClaimsForTest,
} from "./work-claims.js";
import { noteRunFinished, _resetFinishedNotesForTest } from "./finished-note.js";
import { notesSince, postNote, _resetHandoverNotesForTest, _setHandoverNotesForTest } from "./handover-notes.js";

let root: string;
let main: string;
let wt: string;
let holders: string;
let clock = 0;
const ops = new Map<string, Partial<Op>>();

/** A repo with a main checkout and one worktree, laid out as git does it. */
function makeRepo(): void {
  main = join(root, "repo");
  mkdirSync(join(main, ".git", "worktrees", "wt1"), { recursive: true });
  writeFileSync(join(main, ".git", "worktrees", "wt1", "commondir"), "../..\n");
  wt = join(root, "wt1");
  mkdirSync(join(wt, "src", "voice"), { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt1")}\n`);
  mkdirSync(join(main, "src", "voice"), { recursive: true });
}

// Lease expiry is judged on the real clock (canonical-loop/lease.ts), not the test clock.
function op(id: string, lane: Op["lane"], status: Op["status"], task: string, leaseExpiresAt?: string): void {
  ops.set(id, { id, lane, status, task, ...(leaseExpiresAt ? { canonical: { leaseExpiresAt } as Op["canonical"] } : {}) });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-claims-"));
  holders = join(root, "holders");
  makeRepo();
  clock = Date.parse("2026-11-09T12:00:00Z");
  ops.clear();
  _resetRepoLocateCacheForTest();
  _setWorkClaimsForTest({ dir: holders, clock: () => clock, readOp: (id) => (ops.get(id) as Op) ?? null });
});
afterEach(() => _resetWorkClaimsForTest());

describe("repo placement", () => {
  it("puts the main checkout and its worktree in one coordination space", () => {
    const a = locateInRepo(join(main, "src", "voice", "stt.ts"));
    const b = locateInRepo(join(wt, "src", "voice", "stt.ts"));
    expect(a?.repoKey).toBe(b?.repoKey);
    expect(a?.rel).toBe("src/voice/stt.ts");
    expect(b?.rel).toBe("src/voice/stt.ts");
    expect(a?.checkout).not.toBe(b?.checkout);
  });

  it("falls back to the session's folder outside any repo, and to nothing elsewhere", () => {
    const loose = join(root, "loose");
    mkdirSync(loose, { recursive: true });
    expect(locateInRepo(join(loose, "a.txt"))).toBeNull();
    expect(locateInRepo(join(loose, "a.txt"), loose)).toMatchObject({ rel: "a.txt" });
  });
});

describe("claims between parallel agents", () => {
  it("a worker in a worktree and a chat in the main folder see each other's files", () => {
    op("op-w", "agent", "running", "Fix STT latency", new Date(Date.now() + 60_000).toISOString());
    recordClaims({ sessionId: "agent-1", opId: "op-w", paths: [join(wt, "src", "voice", "stt.ts")], source: "written" });

    const clashes = findClashes("chat-a", [join(main, "src", "voice", "stt.ts")]);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toMatchObject({ path: "src/voice/stt.ts", sameCheckout: false });
    expect(clashes[0].other).toMatchObject({ kind: "worker", state: "active", task: "Fix STT latency" });
    expect(findClashes("agent-1", [join(wt, "src", "voice", "stt.ts")])).toEqual([]);
  });

  it("a declared folder covers every file under it, and nothing beside it", () => {
    op("op-a", "interactive", "running", "rework voice", new Date(Date.now() + 60_000).toISOString());
    recordClaims({ sessionId: "chat-a", opId: "op-a", paths: [join(main, "src", "voice")], source: "declared" });
    expect(findClashes("chat-b", [join(main, "src", "voice", "vad.ts")])[0]).toMatchObject({ sameCheckout: true, claim: { source: "declared" } });
    expect(findClashes("chat-b", [join(main, "src", "voiceover.ts")])).toEqual([]);
  });

  it("a chat holds its claims between messages, then only lately, then not at all", () => {
    op("op-a", "interactive", "completed", "edit");
    recordClaims({ sessionId: "chat-a", opId: "op-a", paths: [join(main, "x.ts")], source: "written" });
    expect(liveHolders()[0].state).toBe("idle");
    clock += CHAT_IDLE_HOLD_MS + 1;
    expect(liveHolders()[0].state).toBe("recent");
    clock += RECENT_MS;
    expect(liveHolders()).toEqual([]);
    expect(readdirSync(holders)).toEqual([]);
  });

  it("a worker whose lease lapsed is no longer working", () => {
    op("op-w", "agent", "running", "w", new Date(Date.now() - 1).toISOString());
    recordClaims({ sessionId: "agent-1", opId: "op-w", paths: [join(wt, "y.ts")], source: "written" });
    expect(liveHolders()[0]).toMatchObject({ kind: "worker", state: "recent" });
  });

  it("a new turn makes a chat current again", () => {
    op("op-1", "interactive", "completed", "first");
    recordClaims({ sessionId: "chat-a", opId: "op-1", paths: [join(main, "x.ts")], source: "written" });
    clock += CHAT_IDLE_HOLD_MS + 1;
    op("op-2", "interactive", "running", "second", new Date(Date.now() + 60_000).toISOString());
    touchHolders("chat-a", "op-2", "Voice chat");
    expect(liveHolders()[0]).toMatchObject({ state: "active", displayName: "Voice chat", task: "second" });
  });
});

describe("a worker's area declared when it is spawned", () => {
  it("is held as a working agent's before it has run a tool, then follows its op", () => {
    recordClaims({ sessionId: "agent-9", kind: "worker", paths: [join(wt, "src", "voice")], source: "declared" });
    expect(liveHolders()[0]).toMatchObject({ kind: "worker", state: "active" });
    expect(findClashes("chat-a", [join(main, "src", "voice", "vad.ts")])).toHaveLength(1);

    clock += WORKER_START_GRACE_MS + 1;
    expect(liveHolders()[0].state).toBe("recent");

    op("op-9", "agent", "running", "Rework voice", new Date(Date.now() + 60_000).toISOString());
    noteSessionOp("agent-9", "op-9");
    expect(liveHolders()[0]).toMatchObject({ state: "active", opId: "op-9", task: "Rework voice", kind: "worker" });
  });
});

describe("a run that ends", () => {
  beforeEach(() => { _resetFinishedNotesForTest(); _setHandoverNotesForTest({ dir: join(root, "notes") }); });
  afterEach(() => _resetHandoverNotesForTest());

  it("tells the others what it changed, once", () => {
    op("op-w", "agent", "running", "Fix STT latency", new Date(Date.now() + 60_000).toISOString());
    recordClaims({ sessionId: "agent-1", opId: "op-w", paths: [join(wt, "src", "voice", "stt.ts")], source: "written" });
    noteRunFinished("agent-1");
    noteRunFinished("agent-1");
    const notes = notesSince(liveHolders()[0].repoKey);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "finished", paths: ["src/voice/stt.ts"], text: "Finished: Fix STT latency. Changed 1 file(s) in wt1." });
  });

  it("says nothing more when its merge already announced it, or when it wrote nothing", () => {
    op("op-w", "agent", "running", "Fix STT latency", new Date(Date.now() + 60_000).toISOString());
    recordClaims({ sessionId: "agent-1", opId: "op-w", paths: [join(wt, "a.ts")], source: "written" });
    recordClaims({ sessionId: "agent-2", kind: "worker", paths: [join(wt, "b")], source: "declared" });
    const repoKey = liveHolders()[0].repoKey;
    postNote({ sessionId: "agent-1", displayName: "x", repoKey, paths: ["a.ts"], text: "Merged", kind: "merged" });
    noteRunFinished("agent-1");
    noteRunFinished("agent-2");
    expect(notesSince(repoKey).map((n) => n.kind)).toEqual(["merged"]);
  });
});

