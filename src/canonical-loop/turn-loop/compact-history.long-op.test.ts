// A long single-request op — one task, then tool call after tool call — through
// the real context-manager sizing (getContextStatus is not mocked, as in the
// golden test). It keeps what the model needs to carry on: the task verbatim,
// a recent stretch sized by tokens, and older file dumps as stubs before any
// summary is spent on them.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../context-manager/compaction.js", () => ({ summarizeOldMessages: vi.fn() }));
const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ createLogger: () => loggerMock }));

import { compactHistory } from "./compact-history.js";
import { _resetPrunedBoundaries } from "./prune-tool-rounds.js";
import { summarizeOldMessages } from "../../context-manager/compaction.js";
import { isElidedToolResult } from "../../harness-text.js";
import type { CanonicalMessage } from "../contract-types.js";

const mockSummarize = vi.mocked(summarizeOldMessages);
const MODEL = "claude-sonnet-4-6"; // 200k window
const TASK = "Port src/parser.ts to Rust. Output goes in /app/out/parser.rs; do NOT touch tests/.";

function op(rounds: number, resultChars: number): CanonicalMessage[] {
  const rows: CanonicalMessage[] = [{ messageId: "u0", role: "user", content: { text: TASK } }];
  for (let i = 0; i < rounds; i++) {
    rows.push({ messageId: `a${i}`, role: "assistant", content: { text: `step ${i}`, toolCalls: [{ id: `c${i}`, name: "bash", arguments: "{}" }] } });
    rows.push({ messageId: `t${i}`, role: "tool_result", content: { toolCallId: `c${i}`, result: `[ok]\n${"y".repeat(resultChars)}`, status: "ok" } });
  }
  return rows;
}

const text = (m: CanonicalMessage) => String((m.content as { text?: unknown }).text ?? "");

beforeEach(() => {
  _resetPrunedBoundaries();
  mockSummarize.mockReset();
  mockSummarize.mockResolvedValue("THE SUMMARY");
});

describe("compactHistory on a long single-request op", () => {
  it("stubs old tool output without a summary while the view is under Compact at", async () => {
    const out = await compactHistory(op(10, 20_000), MODEL, null, "op-a");
    expect(out.compacted).toBe(true);
    expect(mockSummarize).not.toHaveBeenCalled();
    const stubs = out.messages.filter((m) => m.role === "tool_result" && isElidedToolResult(String((m.content as { result: unknown }).result)));
    expect(stubs.map((m) => m.messageId)).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("past Compact at, the summary carries the task verbatim and a token-sized recent stretch", async () => {
    const rows = op(40, 1_000); // ~300 tokens a round: under the prune floor, so the summary decides
    const baseline = 0.9 * 200_000 - 12_000; // lands the view just past 90%
    const out = await compactHistory(rows, MODEL, null, undefined, baseline);
    expect(out.compacted).toBe(true);
    const block = text(out.messages[0]);
    expect(block).toContain("THE SUMMARY");
    expect(block).toContain(`[The original request, verbatim:]\n${TASK}`);
    expect(out.messages.length - 1).toBeGreaterThan(6); // more than the old fixed six rows
    expect(out.messages.length - 1).toBeLessThan(rows.length / 2 + 2); // and the summary still freed half
  });
});
