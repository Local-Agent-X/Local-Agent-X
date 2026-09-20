// The per-turn trace artifact: written once beside the turn record, gzipped,
// stamped with the run id, readable back, switchable off, and never able to
// throw into the commit path that calls it.
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterEach } from "vitest";

process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "lax-trace-store-"));

const { publishTurnTrace, readTurnTrace, resolveRunId } = await import("./turn-trace-store.js");
const { opTurnTracePath, opTurnsDir } = await import("./schema.js");
type TurnTrace = import("./adapter-contract.js").TurnTrace;

function trace(text = "ok"): TurnTrace {
  return {
    model: "qwen3:8b",
    baseURL: "http://127.0.0.1:11434/v1",
    request: { systemPrompt: "sys", messages: [{ role: "user", content: "hi" }], tools: [{ name: "read_file" }], temperature: 0.7 },
    response: { rawText: text, text, thinking: "", toolCalls: [], stopReason: "stop", usage: { promptTokens: 12, completionTokens: 2, cachedTokens: 0 }, error: null },
    timing: { startedAt: "2026-09-19T00:00:00.000Z", endedAt: "2026-09-19T00:00:01.000Z", modelMs: 1000 },
  };
}

let n = 0;
const opId = () => `op_trace_test_${process.pid}_${n++}`;

beforeAll(() => { delete process.env.LAX_TRACE_TURNS; delete process.env.LAX_RUN_ID; });
afterEach(() => { delete process.env.LAX_TRACE_TURNS; delete process.env.LAX_RUN_ID; });

describe("turn trace store", () => {
  it("writes the gzipped artifact beside the turn record and reads it back with its stamps", () => {
    const id = opId();
    expect(publishTurnTrace(id, 3, trace())).toBe(true);
    expect(existsSync(opTurnTracePath(id, 3))).toBe(true);
    const back = readTurnTrace(id, 3);
    expect(back?.schemaVersion).toBe(1);
    expect(back?.opId).toBe(id);
    expect(back?.turnIdx).toBe(3);
    expect(back?.runId).toBe(resolveRunId());
    expect(back?.request.systemPrompt).toBe("sys");
    expect(back?.response.usage?.promptTokens).toBe(12);
    // No stage file left behind.
    expect(readdirSync(opTurnsDir(id)).filter((f) => f.endsWith(".stage"))).toHaveLength(0);
  });

  it("never matches the turn reader's `.json` filter", () => {
    const id = opId();
    publishTurnTrace(id, 0, trace());
    expect(readdirSync(opTurnsDir(id)).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  it("publishes once: a second write for the same turn is a no-op", () => {
    const id = opId();
    expect(publishTurnTrace(id, 1, trace("first"))).toBe(true);
    expect(publishTurnTrace(id, 1, trace("second"))).toBe(false);
    expect(readTurnTrace(id, 1)?.response.text).toBe("first");
  });

  it("LAX_RUN_ID stamps the run; LAX_TRACE_TURNS=0 writes nothing", () => {
    process.env.LAX_RUN_ID = "run-eval-42";
    const id = opId();
    publishTurnTrace(id, 0, trace());
    expect(readTurnTrace(id, 0)?.runId).toBe("run-eval-42");

    process.env.LAX_TRACE_TURNS = "0";
    const off = opId();
    expect(publishTurnTrace(off, 0, trace())).toBe(false);
    expect(existsSync(opTurnTracePath(off, 0))).toBe(false);
    expect(readTurnTrace(off, 0)).toBeNull();
  });

  it("a trace that cannot be written is dropped, not thrown", () => {
    // An op id that is not a valid directory name on any platform.
    expect(() => publishTurnTrace("bad\0id", 0, trace())).not.toThrow();
  });
});
