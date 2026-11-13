// The guard-scoring script reads only the op store: each op's events and
// turns. It says what a run did after a guard fired, makes no model call, and
// its table carries no run data (guard names, model families, counts, rates).
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

const data = mkdtempSync(join(tmpdir(), "lax-score-guards-"));
const scorer = await import("../scripts/score-guards.mjs");

type Call = { name: string; args?: Record<string, unknown>; ok?: boolean };

/** One op: its steps (each a list of calls) and the guards that fired on which step. */
function seedOp(id: string, sessionId: string, model: string, steps: Call[][], firings: Array<[string, number]>) {
  const dir = join(data, "operations", id);
  mkdirSync(join(dir, "op-turns"), { recursive: true });
  writeFileSync(join(dir, "operation.json"), JSON.stringify({ id, sessionId, model, type: "chat_turn", task: "PRIVATE TASK TEXT", createdAt: "2026-11-01T00:00:00.000Z" }));
  steps.forEach((calls, idx) => {
    const messages = [
      { role: "assistant", content: { text: "", toolCalls: calls.map((c, i) => ({ id: `c${idx}-${i}`, name: c.name, arguments: JSON.stringify(c.args ?? {}) })) } },
      ...calls.map((c, i) => ({ role: "tool_result", content: { toolCallId: `c${idx}-${i}`, result: c.ok === false ? "[error] nope" : "[ok] fine" } })),
    ];
    writeFileSync(join(dir, "op-turns", `${idx}.json`), JSON.stringify({ turn: { turnIdx: idx }, messages }));
  });
  writeFileSync(join(dir, "canonical-events.jsonl"),
    firings.map(([name, turnIdx], seq) => JSON.stringify({ opId: id, seq, type: "middleware_fired", body: { name, reason: name, outcome: "nudge", turnIdx } })).join("\n") + "\n");
}

beforeAll(() => {
  mkdirSync(join(data, "sessions"), { recursive: true });
  writeFileSync(join(data, "sessions", "code-1.jsonl"), JSON.stringify({ kind: "meta", id: "code-1", mode: "code" }) + "\n");
  writeFileSync(join(data, "sessions", "chat-1.jsonl"), JSON.stringify({ kind: "meta", id: "chat-1" }) + "\n");

  // A failed bash, the notice, then the same tool succeeding with a new command.
  seedOp("op_a", "code-1", "claude-opus-5-5", [
    [{ name: "bash", args: { command: "npm test" }, ok: false }],
    [{ name: "edit", args: { path: "a.ts" } }],
    [{ name: "bash", args: { command: "npm test" } }],
    [{ name: "read", args: { path: "b.ts" } }],
    [{ name: "read", args: { path: "c.ts" } }],
    [{ name: "read", args: { path: "d.ts" } }],
  ], [["tool-failure-summary", 0]]);

  // A done-claim audit the run argued with: nothing edited afterwards, and it ended.
  seedOp("op_b", "code-1", "claude-opus-5-5", [
    [{ name: "edit", args: { path: "a.ts" } }],
    [],
  ], [["spec-audit", 0]]);

  // The same guard in a plain chat: outside a code-only run of the script.
  seedOp("op_c", "chat-1", "grok-4.7", [[{ name: "read", args: { path: "x" } }], []], [["spec-audit", 0]]);
});

describe("scoring one firing", () => {
  it("reads what the failed tool did later, and how long the run went on", () => {
    const steps = [
      [{ name: "bash", key: "bash:1", ok: false, command: "npm test" }],
      [{ name: "edit", key: "edit:1", ok: true, command: "" }],
      [{ name: "bash", key: "bash:2", ok: true, command: "npm test" }],
    ];
    const s = scorer.scoreFiring(steps, 0, "tool-failure-summary");
    expect(s.stepsAfter).toBe(2);
    expect(s.endedWithin3).toBe(true);
    expect(s.changedApproach).toBe(true); // an edit, where the two steps before held only bash
    expect(s.specific).toBe(true);        // bash later succeeded
  });

  it("a verify nudge is answered when a build, type-check or test runs within three steps", () => {
    const run = (command: string) => [[{ name: "edit", key: "e", ok: true, command: "" }], [{ name: "bash", key: `b:${command}`, ok: true, command }]];
    expect(scorer.scoreFiring(run("npx tsc --noEmit"), 0, "verify-gate").specific).toBe(true);
    expect(scorer.scoreFiring(run("git status"), 0, "verify-gate").specific).toBe(false);
  });

  it("a budget message counts as on a flat stretch only when the stretch held no new call", () => {
    const call = (k: string) => [{ name: "read", key: k, ok: true, command: "" }];
    const repeating = [call("a"), call("b"), call("a"), call("b"), call("a")];
    const moving = [call("a"), call("b"), call("c"), call("d"), call("e")];
    expect(scorer.scoreFiring(repeating, 4, "budget-ladder").specific).toBe(true);
    expect(scorer.scoreFiring(moving, 4, "budget-ladder").specific).toBe(false);
  });

  it("names the model family, with anything unknown as local", () => {
    expect(["claude-opus-5-5", "gpt-6-sol", "grok-4.7", "gemini-3-pro", "qwen3.8:27b"].map(scorer.modelFamily))
      .toEqual(["claude", "gpt", "grok", "gemini", "local"]);
  });
});

describe("scoring the recorded runs", () => {
  it("covers code sessions by default and every session when asked", () => {
    const code = scorer.main(["--data", data, "--json"]);
    expect(code.map((g: { guard: string; family: string; fires: number }) => [g.guard, g.family, g.fires]).sort())
      .toEqual([["spec-audit", "claude", 1], ["tool-failure-summary", "claude", 1]]);
    const all = scorer.main(["--data", data, "--session-mode", "all", "--json"]);
    expect(all.some((g: { family: string }) => g.family === "grok")).toBe(true);
  });

  it("the audit the run argued with shows as ended, with no edit after it", () => {
    const [audit] = scorer.main(["--data", data, "--json"]).filter((g: { guard: string }) => g.guard === "spec-audit");
    expect(audit.ended).toBe(1);
    expect(audit.specific).toBe(0);
    expect(audit.specificOf).toBe(1);
  });

  it("the table holds no run data; the detail file does, and only when asked for", () => {
    const table = scorer.renderTable(scorer.main(["--data", data, "--json"]));
    expect(table).toContain("| spec-audit | claude | 1 | 1 | 100% |");
    expect(table).not.toMatch(/op_[ab]|PRIVATE TASK TEXT|code-1/);

    const detail = join(data, "detail.md");
    scorer.main(["--data", data, "--json", "--detail", detail]);
    expect(readFileSync(detail, "utf8")).toMatch(/spec-audit · claude-opus-5-5 · op_b step 0/);
  });
});
