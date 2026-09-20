// The trace viewer reads only the op store: operation.json, the turn rows and
// the gzipped trace artifacts. It lists ops with their measured numbers, shows
// one op turn by turn, and names where two ops' prompts stop agreeing.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

const data = mkdtempSync(join(tmpdir(), "lax-trace-viewer-"));
process.env.LAX_DATA_DIR = data;

const { publishTurnTrace } = await import("../src/canonical-loop/turn-trace-store.js");
const viewer = await import("../scripts/lax-trace.mjs");

function seedOp(id: string, systemPrompt: string, tools: string[], turns: Array<{ in: number; cached: number; ttft: number }>) {
  const dir = join(data, "operations", id);
  mkdirSync(join(dir, "op-turns"), { recursive: true });
  writeFileSync(join(dir, "operation.json"), JSON.stringify({ id, type: "chat_turn", status: "completed", createdAt: `2026-09-19T00:00:0${turns.length}.000Z` }));
  turns.forEach((t, idx) => {
    writeFileSync(join(dir, "op-turns", `${idx}.json`), JSON.stringify({
      turn: {
        turnIdx: idx, modelMs: 500, terminalReason: idx === turns.length - 1 ? "done" : null,
        toolCallSummary: idx === 0 ? [{ tool: "read_file", resultStatus: "ok" }] : [],
        providerState: { providerPayload: { model: "qwen3:8b", stopReason: "stop", usageInputTokens: t.in, usageOutputTokens: 20, promptCachedTokens: t.cached, ttftMs: t.ttft } },
      },
    }));
    publishTurnTrace(id, idx, {
      model: "qwen3:8b",
      request: { systemPrompt, messages: [{ role: "user", content: "hi" }], tools: tools.map((name) => ({ name })) },
      response: { rawText: "ok", text: "ok", thinking: "hmm", toolCalls: [], stopReason: "stop", usage: { promptTokens: t.in, completionTokens: 20, cachedTokens: t.cached }, ttftMs: t.ttft, error: null },
      timing: { startedAt: "2026-09-19T00:00:00.000Z", endedAt: "2026-09-19T00:00:00.500Z", modelMs: 500 },
    });
  });
}

beforeAll(() => {
  seedOp("op_chat_turn_aaaa1111", "You are LAX. Be brief.", ["read_file", "bash"], [{ in: 17_000, cached: 0, ttft: 1500 }, { in: 17_100, cached: 16_900, ttft: 100 }]);
  seedOp("op_chat_turn_bbbb2222", "You are LAX. Be brief. Today is Friday.", ["read_file", "bash", "glob"], [{ in: 23_000, cached: 1, ttft: 2500 }]);
  seedOp("op_chat_turn_cccc1111", "You are LAX.", ["bash"], [{ in: 1_000, cached: 0, ttft: 200 }]);
});

describe("lax-trace viewer", () => {
  it("lists ops with tokens, cache, first-token latency and trace coverage", () => {
    const rows = viewer.listOps(data).map(viewer.summarizeOp);
    const a = rows.find((r: { op: string }) => r.op.endsWith("aaaa1111"));
    expect(a).toMatchObject({ turns: 2, traced: 2, tokIn: 34_100, cached: 16_900, ttftAvgMs: 800, tools: 1, model: "qwen3:8b" });
  });

  it("resolves an op by suffix and shows its turns", () => {
    const entry = viewer.resolveOp(data, "aaaa1111");
    expect(entry.id).toBe("op_chat_turn_aaaa1111");
    const rows = viewer.turnRows(entry);
    expect(rows[1]).toMatchObject({ turn: 1, cached: 16_900, ttftMs: 100, promptTools: 2, thinkChars: 3 });
    const text = viewer.renderTurn(entry.turns[0]);
    expect(text).toContain("2 tools [read_file,bash]");
    expect(text).toContain("17000 in / 20 out / 0 cached");
  });

  it("names where two ops' prompts diverge", () => {
    const a = viewer.resolveOp(data, "aaaa1111"), b = viewer.resolveOp(data, "bbbb2222");
    const d = viewer.firstDivergence(a, b);
    expect(d).toContain("diverges at char 22");
    expect(d).toContain("only in B: [glob]");
  });

  it("refuses an ambiguous suffix and names both candidates", () => {
    expect(() => viewer.resolveOp(data, "1111")).toThrow(/ambiguous.*aaaa1111.*cccc1111|ambiguous.*cccc1111.*aaaa1111/);
    expect(() => viewer.resolveOp(data, "zzzz")).toThrow(/no op matches/);
  });
});
