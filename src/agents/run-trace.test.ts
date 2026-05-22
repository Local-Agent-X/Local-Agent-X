import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  TRACES_DIR,
  appendTraceEvent,
  readTrace,
  capValue,
  type TraceEvent,
} from "./run-trace.js";

const TEST_PREFIX = "test-trace-";

function freshRunId(): string {
  return TEST_PREFIX + Math.random().toString(36).slice(2, 10);
}

function tracePath(runId: string): string {
  return join(TRACES_DIR, `${runId}.jsonl`);
}

function cleanup(runId: string): void {
  const p = tracePath(runId);
  if (existsSync(p)) rmSync(p, { force: true });
}

describe("run-trace", () => {
  const tracked: string[] = [];
  afterEach(() => { while (tracked.length) cleanup(tracked.pop()!); });

  it("append + read round-trips a discriminated event sequence", () => {
    const id = freshRunId(); tracked.push(id);
    const events: TraceEvent[] = [
      { type: "run_start", runId: id, ts: 1_000, role: "researcher", task: "do thing" },
      { type: "tool_call_started", runId: id, ts: 1_100, toolCallId: "tc-1", toolName: "read", risk: "workspace-read", decision: "allow", args: '{"path":"/tmp/x"}' },
      { type: "tool_call_completed", runId: id, ts: 1_200, toolCallId: "tc-1", ok: true, durationMs: 100, resultPreview: "hello" },
      { type: "run_end", runId: id, ts: 1_300, status: "succeeded", tokensUsed: 42 },
    ];
    for (const ev of events) appendTraceEvent(id, ev);

    const read = readTrace(id);
    expect(read).toHaveLength(4);
    expect(read[0].type).toBe("run_start");
    expect(read[3].type).toBe("run_end");
    if (read[1].type === "tool_call_started") {
      expect(read[1].toolName).toBe("read");
      expect(read[1].decision).toBe("allow");
    }
    if (read[2].type === "tool_call_completed") {
      expect(read[2].ok).toBe(true);
      expect(read[2].durationMs).toBe(100);
    }
  });

  it("appendTraceEvent is append-only across multiple calls", () => {
    const id = freshRunId(); tracked.push(id);
    appendTraceEvent(id, { type: "run_start", runId: id, ts: 1, role: "x", task: "t" });
    appendTraceEvent(id, { type: "run_end", runId: id, ts: 2, status: "succeeded" });

    const raw = readFileSync(tracePath(id), "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("run_start");
    expect(JSON.parse(lines[1]).type).toBe("run_end");
  });

  it("readTrace returns [] for an unknown runId (no file)", () => {
    const events = readTrace("never-existed-" + Math.random().toString(36).slice(2));
    expect(events).toEqual([]);
  });

  it("readTrace tolerates a malformed line without dropping the rest", () => {
    const id = freshRunId(); tracked.push(id);
    if (!existsSync(TRACES_DIR)) mkdirSync(TRACES_DIR, { recursive: true });
    const good1 = JSON.stringify({ type: "run_start", runId: id, ts: 1, role: "r", task: "t" });
    const good2 = JSON.stringify({ type: "run_end", runId: id, ts: 9, status: "failed" });
    writeFileSync(tracePath(id), good1 + "\n{not json\n" + good2 + "\n", "utf-8");

    const events = readTrace(id);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("run_start");
    expect(events[1].type).toBe("run_end");
  });

  it("capValue truncates oversized strings with a marker", () => {
    const big = "a".repeat(10_000);
    const capped = capValue(big, 2048);
    expect(capped.length).toBeLessThanOrEqual(2048);
    expect(capped).toContain("truncated");
  });

  it("capValue stringifies objects and caps them too", () => {
    const obj = { huge: "b".repeat(10_000) };
    const capped = capValue(obj, 2048);
    expect(capped.length).toBeLessThanOrEqual(2048);
    expect(capped).toContain("truncated");
  });

  it("capValue passes small values through untouched", () => {
    expect(capValue("hi")).toBe("hi");
    expect(capValue({ a: 1 })).toBe('{"a":1}');
  });

  it("appendTraceEvent caps oversized args via capValue so traces don't blow up", () => {
    const id = freshRunId(); tracked.push(id);
    const big = "z".repeat(50_000);
    appendTraceEvent(id, {
      type: "tool_call_started",
      runId: id,
      ts: 1,
      toolCallId: "tc-big",
      toolName: "read",
      risk: "workspace-read",
      decision: "allow",
      args: capValue({ blob: big }),
    });
    const events = readTrace(id);
    expect(events).toHaveLength(1);
    if (events[0].type === "tool_call_started") {
      expect(events[0].args.length).toBeLessThanOrEqual(2048);
      expect(events[0].args).toContain("truncated");
    }
  });
});
