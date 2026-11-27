// The Usage tab's "where it went" (2026-11-27): what each run was, why it ran,
// and what stands out about its cost. Built from the shapes real runs had that
// day: a lead decision, a reviewer, a finish fix, the 194-call chat turn.
import { describe, it, expect } from "vitest";
import { runKindOf } from "./run-kind.js";
import { flagsOf } from "./runs.js";
import type { OpCallUsage } from "../canonical-loop/public/op-facts.js";

const op = (type: string, task: string, workRoot?: string) =>
  ({ type, task, contextPack: { routing: workRoot ? { workRoot } : {} } }) as never;

describe("runKindOf", () => {
  it("names a chat turn you typed by its first line", () => {
    expect(runKindOf(op("chat_turn", "Fix data loss\nmore"))).toEqual({ kind: "chat", reason: "you typed", title: "Fix data loss" });
  });

  it("names a build decision by its headline, not the app's preamble", () => {
    const task = "(Sent by the app, not typed by the user: a build decision is waiting.)\n\nDecision bd-1a2b3c4d: chunk 3/8, \"Label scanner\", after fix round 2 of at most 4.\nSlice: x";
    expect(runKindOf(op("chat_turn", task))).toEqual({ kind: "chat", reason: "build decision", title: 'chunk 3/8, "Label scanner", after fix round 2 of at most 4.' });
  });

  it("names a background-work notice and another app message apart", () => {
    expect(runKindOf(op("chat_turn", "(Sent by the app, not typed by the user: background work you started has ended.) - \"The build\" failed.")).reason).toBe("background work ended");
    expect(runKindOf(op("chat_turn", "(Sent by the app, not typed by the user: a reminder.)")).reason).toBe("app message");
  });

  it("names a worker by the job the build engine gave it, with its project", () => {
    const root = "C:\\Users\\me\\Documents\\Local Agent X\\workspace\\apps\\label-check-grok";
    expect(runKindOf(op("agent_spawn", "Skeptic: Chunk 3: Label scanner", root))).toMatchObject({ kind: "worker", reason: "review", project: "label-check-grok", title: "Chunk 3: Label scanner" });
    expect(runKindOf(op("agent_spawn", "Skeptic: Finish fix 1: auditor findings", root)).reason).toBe("finish-fix review");
    expect(runKindOf(op("agent_spawn", "Finish fix 1: auditor findings", root)).reason).toBe("finish fix");
    expect(runKindOf(op("agent_spawn", "Build chunk 4: Firebase AI Logic adapter", root)).reason).toBe("build chunk");
  });

  it("keeps a background job's type as its reason", () => {
    expect(runKindOf(op("mail_watch", "Check the inbox"))).toEqual({ kind: "background", reason: "mail watch", title: "Check the inbox" });
  });
});

const call = (promptTokens: number, cachedTokens: number, tools: Array<[string, string]> = []): OpCallUsage => ({
  turnIdx: 0, at: "", promptTokens, cachedTokens, outputTokens: 10, tools: tools.map(([tool, argsHash]) => ({ tool, argsHash, status: "ok" })),
});
const flags = (calls: OpCallUsage[]) => {
  const prompt = calls.reduce((n, c) => n + c.promptTokens, 0);
  const cached = calls.reduce((n, c) => n + c.cachedTokens, 0);
  return flagsOf(calls, prompt, cached, Math.max(...calls.map((c) => c.promptTokens)));
};

describe("flagsOf", () => {
  it("flags the 194-call turn: its calls, their size, its tool lookups", () => {
    const calls = Array.from({ length: 194 }, (_, i) => call(300_000, 0, i % 3 === 0 ? [["tool_search", `q${i % 2}`]] : [["bash", `h${i}`]]));
    expect(flags(calls)).toEqual(["194 calls in one run", "~300K tokens in its biggest call", "no cache use reported", "tool_search called 33× with the same arguments", "65 tool lookups"]);
  });

  it("says a low cache share as a share, and nothing for an ordinary run", () => {
    expect(flags(Array.from({ length: 6 }, () => call(40_000, 4_000)))).toEqual(["only 10% from cache"]);
    expect(flags([call(20_000, 15_000), call(25_000, 20_000)])).toEqual([]);
  });
});
