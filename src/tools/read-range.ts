/**
 * How many lines a `read` returns from its offset.
 *
 * A file under SHORT_FILE_LINES comes back whole from the offset, its `limit`
 * ignored: weak models chunked small files into dozens of tiny reads. A strong
 * model asking for one section of a short file got the rest of it as well: 75
 * lines of a 671-line spec came back as 344 lines, 36k chars (glasses chat,
 * 2026-11-27). A strong model's `limit` is honored at any size. The offset is
 * always honored: an oversize result names the offset that continues it
 * (tool-execution/read-budget.ts).
 */
import { readOp } from "../ops/op-store.js";
import { resolveOpModel } from "../canonical-loop/public/op-facts.js";
import { classifyModel } from "../model-tiers.js";
import { operationIdOf } from "../tool-execution/internal-args.js";

export const SHORT_FILE_LINES = 1000;

/** The model this call runs under is strong; false when it cannot be told. */
function strongModel(args: Record<string, unknown>): boolean {
  const opId = operationIdOf(args);
  if (!opId) return false;
  try {
    const op = readOp(opId);
    const model = op ? resolveOpModel(op) : undefined;
    return !!model && classifyModel(model) === "strong";
  } catch {
    return false; // an op that cannot be read gets the rule for any model
  }
}

/** Lines to return starting at `offset` (0-based) of a file `total` lines long. */
export function linesToRead(total: number, offset: number, args: Record<string, unknown>): number {
  const rest = total - offset;
  const asked = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 0;
  if (asked === 0) return rest;
  if (total < SHORT_FILE_LINES && !strongModel(args)) return rest;
  return Math.min(asked, rest);
}
