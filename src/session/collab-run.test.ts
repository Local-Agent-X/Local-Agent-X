// Running a collab's steps (ADR 0007 §9): research, challenge, answer, rounds
// on what is still disputed, then the starting chat writes a result the app
// checks. A member that fails is dropped and the rest go on; Stop ends it.
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
import { claimStatus } from "../agency/collab-claims.js";
import { closeIfCutOff, replyAfter, runCollab, setCollabChangedListener, stopCollab } from "./collab-run.js";

type Row = { role: string; content: string };
type Step = "research" | "repair" | "challenge" | "answer" | "dispute" | "result" | "missing";
let sessions: Record<string, { messages: Row[] }>;
const ctx = {
  sessionStore: { load: (id: string) => sessions[id] ?? null },
  flushSession: async () => {},
} as unknown as Parameters<typeof runCollab>[0];

const collab = (over: Partial<Collab> = {}): Collab => ({
  id: "collab-1", hostId: "host", hostTitle: "Host chat", question: "Q?", steps: 3, depth: "standard", phase: "research", disputeRound: 0,
  state: "running", claims: [], startedAt: "2026-11-11T00:00:00.000Z",
  members: [
    { sessionId: "m1", provider: "anthropic", model: "opus", label: "opus", letter: "A", report: "" },
    { sessionId: "m2", provider: "codex", model: "gpt", label: "gpt", letter: "B", report: "" },
  ],
  ...over,
});

function stepOf(message: string): Step {
  if (message.includes("has no CLAIMS section")) return "repair";
  if (message.startsWith("(Collab, research")) return "research";
  if (message.startsWith("(Collab, challenge")) return "challenge";
  if (message.startsWith("(Collab, answer")) return "answer";
  if (message.startsWith("(Collab, settling disputes")) return "dispute";
  return message.startsWith("(Collab finished") ? "result" : "missing";
}

/** A chat runner that saves the message and replies with `reply(sessionId, step, message)`. */
function runner(reply: (id: string, step: Step, message: string) => string | null) {
  const got: Array<{ id: string; step: Step; message: string }> = [];
  setChatHandler(async (id, message) => {
    const step = stepOf(message);
    got.push({ id, step, message });
    const rows = (sessions[id] ??= { messages: [] }).messages;
    rows.push({ role: "user", content: message });
    const text = reply(id, step, message);
    if (text !== null) rows.push({ role: "assistant", content: text });
  });
  return got;
}

const REPORTS: Record<string, string> = {
  m1: "Report of m1\nCLAIMS\nC1: alpha | SOURCE: https://e.org/a\nC2: beta | SOURCE: https://e.org/b",
  m2: "Report of m2\nCLAIMS\nC1: gamma | SOURCE: https://e.org/c",
};
const VERDICTS: Record<string, string> = {
  m1: "VERDICTS\nB1: CONFIRMED",
  m2: "VERDICTS\nA1: CONFIRMED\nA2: CHALLENGED | beta is wrong | SOURCE: https://e.org/no",
};
const seq = (got: Array<{ id: string; step: Step }>) => got.map((g) => `${g.id}:${g.step}`);

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
  it("research, challenge, answer, a round on what is still disputed, then the result; the starting chat runs no turn before it", async () => {
    saveNewCollab(collab());
    const got = runner((id, step) => {
      if (step === "research") return REPORTS[id];
      if (step === "challenge") return VERDICTS[id];
      if (step === "answer") return "RESPONSES\nA2: DEFENDED | FACT | beta holds | SOURCE: https://e.org/b2\n\nFINAL REPORT of m1";
      if (step === "dispute") return id === "m2" ? "A2: WITHDRAWN | the data agrees" : "A2: DEFENDED | still holds | SOURCE: https://e.org/b3";
      return "THE RESULT";
    });
    const changes: string[] = [];
    setCollabChangedListener((id) => changes.push(id));
    await runCollab(ctx, "collab-1");

    expect(seq(got)).toEqual(["m1:research", "m2:research", "m1:challenge", "m2:challenge", "m1:answer", "m1:dispute", "m2:dispute", "host:result"]);
    // Each member checks the other's claims, and only the challenged one answers.
    expect(got[2].message).toContain("B1: gamma");
    expect(got[2].message).not.toContain("A1: alpha");
    expect(got[4].message).toContain('"gpt" challenges it: beta is wrong');
    const done = getCollab("collab-1")!;
    expect(done.state).toBe("done");
    expect(done.note).toBeUndefined();
    expect(done.claims.map((x) => `${x.id}:${claimStatus(x)}`)).toEqual(["A1:confirmed", "A2:confirmed", "B1:confirmed"]);
    expect(done.members[0].report).toContain("FINAL REPORT of m1");
    expect(got.at(-1)!.message).toContain("FINAL REPORT of m1");
    expect(changes.length).toBeGreaterThan(0);
    // A member takes on the host's marks before its turn and gives back what it read after.
    expect(lineage.slice(0, 2).sort()).toEqual(["in:m1<-host", "in:m2<-host"]);
    expect(lineage.filter((l) => l.startsWith("out:"))).toHaveLength(7);
  });

  it("stops the dispute rounds when nobody moved, and the result is sent the dispute still open", async () => {
    saveNewCollab(collab());
    const got = runner((id, step) => {
      if (step === "research") return REPORTS[id];
      if (step === "challenge") return VERDICTS[id];
      if (step === "answer") return "RESPONSES\nA2: DEFENDED | FACT | beta holds\n\nFINAL";
      if (step === "dispute") return id === "m2" ? "A2: MAINTAINED | still wrong" : "A2: DEFENDED | still holds";
      return "Unresolved: [A2] stays open.";
    });
    await runCollab(ctx, "collab-1");
    expect(got.filter((g) => g.step === "dispute")).toHaveLength(2);
    expect(got.at(-1)!.message).toContain("OPEN DISPUTES:");
    expect(getCollab("collab-1")!.note).toBeUndefined();
    expect(got.some((g) => g.step === "missing")).toBe(false);
  });

  it("asks once more for a report with no claims the app could read", async () => {
    saveNewCollab(collab({ steps: 2 }));
    const got = runner((id, step) => {
      if (step === "research") return id === "m2" ? "A report in prose, no list." : REPORTS[id];
      if (step === "repair") return "CLAIMS\nC1: gamma | SOURCE: https://e.org/c";
      if (step === "challenge") return "VERDICTS\nA1: CONFIRMED\nB1: CONFIRMED";
      return "RESULT";
    });
    await runCollab(ctx, "collab-1");
    expect(seq(got)).toEqual(["m1:research", "m2:research", "m2:repair", "m1:challenge", "m2:challenge", "host:result"]);
    const done = getCollab("collab-1")!;
    expect(done.members[1].noClaims).toBeUndefined();
    expect(done.members[1].report).toBe("A report in prose, no list.");
    expect(done.claims.map((x) => x.id)).toEqual(["A1", "A2", "B1"]);
  });

  it("asks the starting chat once for an open dispute its result left out, and puts on the record what is still missing", async () => {
    saveNewCollab(collab({ steps: 2 }));
    const got = runner((id, step) => (step === "research" ? REPORTS[id] : step === "challenge" ? VERDICTS[id] : "A result that names no dispute."));
    await runCollab(ctx, "collab-1");
    expect(seq(got).slice(-2)).toEqual(["host:result", "host:missing"]);
    expect(got.at(-1)!.message).toContain("[A2]");
    const done = getCollab("collab-1")!;
    expect(done.state).toBe("done");
    expect(done.note).toBe("The result does not name this open dispute: A2. Ask this chat about it by id.");
  });

  it("leaves no note when the second ask names the dispute", async () => {
    saveNewCollab(collab({ steps: 2 }));
    runner((id, step) => (step === "research" ? REPORTS[id] : step === "challenge" ? VERDICTS[id] : step === "missing" ? "Unresolved: [A2]." : "No disputes named."));
    await runCollab(ctx, "collab-1");
    expect(getCollab("collab-1")!.note).toBeUndefined();
  });

  it("research only: one turn each, no second ask, then the result", async () => {
    saveNewCollab(collab({ steps: 1 }));
    const got = runner((_id, step) => (step === "research" ? "Prose with no list." : "RESULT"));
    await runCollab(ctx, "collab-1");
    expect(seq(got)).toEqual(["m1:research", "m2:research", "host:result"]);
    expect(got.at(-1)!.message).toContain("The models did not check each other");
  });

  it("drops a member that gives no report, names it, and goes on with the rest", async () => {
    saveNewCollab(collab({ steps: 2 }));
    const got = runner((id, step) => (id === "m2" ? null : step === "research" ? REPORTS[id] : "RESULT"));
    await runCollab(ctx, "collab-1");
    const done = getCollab("collab-1")!;
    expect(done.members[1].dropped).toBe("it gave no answer");
    expect(got.filter((g) => g.id === "m2")).toHaveLength(1);
    expect(got.at(-1)!.message).toContain('Left the collab without finishing: "gpt" (it gave no answer).');
    expect(done.state).toBe("done");
  });

  it("stops without a result when nobody reports", async () => {
    saveNewCollab(collab());
    const got = runner(() => null);
    await runCollab(ctx, "collab-1");
    const c = getCollab("collab-1")!;
    expect(c.state).toBe("stopped");
    expect(c.note).toBe("No member gave a report.");
    expect(got.some((g) => g.id === "host")).toBe(false);
  });

  it("Stop cuts the turns in flight, runs no further step and drops nobody for it", async () => {
    saveNewCollab(collab());
    const got = runner((id) => { if (id === "m1") stopCollab("collab-1"); return id === "m1" ? null : REPORTS.m2; });
    await runCollab(ctx, "collab-1");
    const c = getCollab("collab-1")!;
    expect(c.state).toBe("stopped");
    expect(c.note).toBe("Stopped by the user.");
    expect(aborted).toEqual(["m1", "m2"]);
    expect(c.members.every((m) => !m.dropped)).toBe(true);
    expect(seq(got)).toEqual(["m1:research", "m2:research"]);
  });

  it("a record still marked running that this process is not running was cut off by a restart", () => {
    saveNewCollab(collab({ phase: "challenge" }));
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
