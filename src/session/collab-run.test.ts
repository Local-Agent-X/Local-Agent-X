// Running a collab's rounds (ADR 0007 §9): every member answers each round,
// a member that fails is dropped and the rest go on, the starting chat writes
// the result, and Stop ends it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lineage: string[] = [];
vi.mock("../canonical-loop/index.js", () => ({
  inheritSessionLineage: (child: string, parent: string) => { lineage.push(`in:${child}<-${parent}`); },
  returnSessionLineage: (child: string, parent: string) => { lineage.push(`out:${child}->${parent}`); },
}));
const aborted: string[] = [];
vi.mock("./turn-lock.js", () => ({
  abortTurn: (id: string) => { aborted.push(id); return true; },
  hasActiveTurn: () => false,
  onTurnRelease: (_id: string, cb: () => void) => cb(),
}));

import { setChatHandler } from "../chat-ws/chat-handler.js";
import { _setCollabFileForTest, getCollab, saveNewCollab, type Collab } from "../agency/collab.js";
import { closeIfCutOff, replyAfter, runCollab, setCollabChangedListener, stopCollab } from "./collab-run.js";

type Row = { role: string; content: string };
let sessions: Record<string, { messages: Row[] }>;
const ctx = {
  sessionStore: { load: (id: string) => sessions[id] ?? null },
  flushSession: async () => {},
} as unknown as Parameters<typeof runCollab>[0];

const collab = (over: Partial<Collab> = {}): Collab => ({
  id: "collab-1", hostId: "host", hostTitle: "Host chat", question: "Q?", rounds: 2, round: 0, state: "running",
  startedAt: "2026-11-11T00:00:00.000Z",
  members: [
    { sessionId: "m1", provider: "anthropic", model: "opus", label: "opus", answers: [] },
    { sessionId: "m2", provider: "codex", model: "gpt", label: "gpt", answers: [] },
  ],
  ...over,
});

/** A chat runner that saves the message and replies with `reply(sessionId, message)`. */
function runner(reply: (id: string, message: string) => string | null | Promise<string | null>) {
  const got: Array<{ id: string; message: string }> = [];
  setChatHandler(async (id, message) => {
    got.push({ id, message });
    const rows = (sessions[id] ??= { messages: [] }).messages;
    rows.push({ role: "user", content: message });
    const text = await reply(id, message);
    if (text !== null) rows.push({ role: "assistant", content: text });
  });
  return got;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collab-run-"));
  _setCollabFileForTest(join(dir, "collabs.json"));
  sessions = { host: { messages: [] }, m1: { messages: [] }, m2: { messages: [] } };
  lineage.length = 0; aborted.length = 0;
  setCollabChangedListener(() => {});
});
afterEach(() => { _setCollabFileForTest(null); rmSync(dir, { recursive: true, force: true }); });

describe("running a collab", () => {
  it("runs every round for every member, shows each the others' answer, then has the host write the result", async () => {
    saveNewCollab(collab());
    const got = runner((id, message) => (id === "host" ? "THE RESULT" : `${id} answer to ${message.includes("round 1") ? "r1" : "r2"}`));
    const changes: string[] = [];
    setCollabChangedListener((id) => changes.push(id));
    await runCollab(ctx, "collab-1");

    expect(got.map((g) => g.id)).toEqual(["m1", "m2", "m1", "m2", "host"]);
    expect(got[2].message).toContain("m2 answer to r1");
    expect(got[2].message).not.toContain("m1 answer to r1");
    expect(got[4].message).toContain("m1 answer to r2");
    expect(got[4].message).toContain("m2 answer to r2");
    const done = getCollab("collab-1")!;
    expect(done.state).toBe("done");
    expect(done.round).toBe(2);
    expect(done.members.map((m) => m.answers)).toEqual([["m1 answer to r1", "m1 answer to r2"], ["m2 answer to r1", "m2 answer to r2"]]);
    expect(changes.length).toBeGreaterThan(0);
    // A member takes on the host's marks before its turn and gives back what it read after.
    expect(lineage.slice(0, 2).sort()).toEqual(["in:m1<-host", "in:m2<-host"]);
    expect(lineage.filter((l) => l.startsWith("out:"))).toHaveLength(4);
  });

  it("drops a member that gives no answer, names it, and goes on with the rest", async () => {
    saveNewCollab(collab());
    const got = runner((id) => (id === "m2" ? null : id === "host" ? "RESULT" : "opus says"));
    await runCollab(ctx, "collab-1");
    const done = getCollab("collab-1")!;
    expect(done.members[1].dropped).toBe("it gave no answer");
    expect(got.filter((g) => g.id === "m2")).toHaveLength(1);
    expect(got.at(-1)!.message).toContain('Left the collab without finishing: "gpt" (it gave no answer).');
    expect(done.state).toBe("done");
  });

  it("drops a member whose turn throws", async () => {
    saveNewCollab(collab({ rounds: 1 }));
    runner((id) => { if (id === "m1") throw new Error("provider down"); return "ok"; });
    await runCollab(ctx, "collab-1");
    expect(getCollab("collab-1")!.members[0].dropped).toBe("its turn stopped with an error");
  });

  it("stops without a result when nobody answers", async () => {
    saveNewCollab(collab());
    const got = runner(() => null);
    await runCollab(ctx, "collab-1");
    const c = getCollab("collab-1")!;
    expect(c.state).toBe("stopped");
    expect(c.note).toBe("No member gave an answer.");
    expect(got.some((g) => g.id === "host")).toBe(false);
  });

  it("Stop cuts the turns in flight, runs no further round and drops nobody for it", async () => {
    saveNewCollab(collab());
    const got = runner((id) => { if (id === "m1") stopCollab("collab-1"); return id === "m1" ? null : "late answer"; });
    await runCollab(ctx, "collab-1");
    const c = getCollab("collab-1")!;
    expect(c.state).toBe("stopped");
    expect(c.note).toBe("Stopped by the user.");
    expect(aborted).toEqual(["m1", "m2"]);
    expect(c.members.every((m) => !m.dropped)).toBe(true);
    expect(got.map((g) => g.id)).toEqual(["m1", "m2"]);
  });

  it("a record still marked running that this process is not running was cut off by a restart", () => {
    saveNewCollab(collab({ round: 1 }));
    const closed = closeIfCutOff(getCollab("collab-1")!);
    expect(closed.state).toBe("stopped");
    expect(closed.note).toContain("restarted");
    expect(closeIfCutOff(closed)).toEqual(closed);
  });
});

describe("replyAfter", () => {
  it("reads the reply written after the turn began, not an older one", () => {
    const rows = [{ role: "user", content: "q1" }, { role: "assistant", content: "old" }, { role: "user", content: "q2" }];
    expect(replyAfter({ messages: rows } as never, 2)).toBeNull();
    expect(replyAfter({ messages: [...rows, { role: "assistant", content: " new " }] } as never, 2)).toBe("new");
    expect(replyAfter(null, 0)).toBeNull();
  });
});
