/**
 * Inside one op, older rounds' tool output leaves the model's view in batches,
 * and the rows before the pinned boundary never change between batches — that
 * is what keeps a local runtime from re-reading the whole view every turn.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalMessage } from "../contract-types.js";
import { isElidedToolResult } from "../../harness-text.js";
import { PRUNE_KEEP_TOOL_ROUNDS } from "../../context-manager/compaction-policy.js";
import { _resetPrunedBoundaries, keepBoundary, pruneToolRounds } from "./prune-tool-rounds.js";

const BIG = 20_000; // chars per result: ~5.7k tokens, so 3 rounds clear the 16k batch floor

/** One user task, then `rounds` read rounds; round i's output is `size` chars. */
function op(rounds: number, size = BIG): CanonicalMessage[] {
  const rows: CanonicalMessage[] = [{ messageId: "u0", role: "user", content: { text: "port the parser to rust" } }];
  for (let i = 0; i < rounds; i++) {
    rows.push({ messageId: `a${i}`, role: "assistant", content: { text: `step ${i}`, toolCalls: [{ id: `c${i}`, name: "read", arguments: `{"path":"f${i}.ts"}` }] } });
    rows.push({ messageId: `t${i}`, role: "tool_result", content: { toolCallId: `c${i}`, result: `[ok]\n${"x".repeat(size)}`, status: "ok" } });
  }
  return rows;
}

const resultOf = (m: CanonicalMessage) => String((m.content as { result: unknown }).result);
const stubbed = (rows: CanonicalMessage[]) => rows.filter((m) => m.role === "tool_result" && isElidedToolResult(resultOf(m))).map((m) => m.messageId);

beforeEach(() => _resetPrunedBoundaries());

describe("pruneToolRounds", () => {
  it("stubs output older than the newest rounds and keeps every user and assistant row verbatim", () => {
    const rows = op(10);
    const out = pruneToolRounds(rows, "op1");
    expect(out.changed).toBe(true);
    expect(stubbed(out.messages)).toEqual(["t0", "t1", "t2", "t3"]);
    expect(resultOf(out.messages[2])).toBe("[earlier tool result elided — read, 20005 chars. The file or command is still there to read or run again.]");
    expect(out.messages.filter((m) => m.role !== "tool_result")).toEqual(rows.filter((m) => m.role !== "tool_result"));
    expect((out.messages[2].content as { status: string }).status).toBe("ok");
  });

  it("leaves a view alone while what it would take out is under the batch floor", () => {
    const out = pruneToolRounds(op(PRUNE_KEEP_TOOL_ROUNDS + 2), "op1"); // 2 old rounds, ~11k tokens
    expect(out.changed).toBe(false);
  });

  it("holds the boundary between batches, so the rows before it are identical turn to turn", () => {
    const first = pruneToolRounds(op(10), "op1").messages;
    const next = pruneToolRounds(op(11), "op1").messages; // one more round: ~5.7k more to take, under the floor
    expect(stubbed(next)).toEqual(["t0", "t1", "t2", "t3"]);
    expect(next.slice(0, first.length)).toEqual(first);
    const later = pruneToolRounds(op(13), "op1").messages; // three rounds past the boundary: a new batch
    expect(stubbed(later)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6"]);
  });

  it("keeps a short result whole: an error line says more than its stub would", () => {
    const out = pruneToolRounds(op(12, 400), "op1");
    expect(out.changed).toBe(false);
  });

  it("finds the newest rounds by their tool calls", () => {
    expect(keepBoundary(op(PRUNE_KEEP_TOOL_ROUNDS))).toBe(-1);
    expect(keepBoundary(op(PRUNE_KEEP_TOOL_ROUNDS + 1))).toBe(3); // a1, the second round's call
  });
});
