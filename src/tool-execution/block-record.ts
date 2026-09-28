// One durable record per blocked call, derived from the result envelope at the
// seam every block passes through (terminate / shapeMsg). Rides the tool
// message as `_block` — the same carry `_media` uses — so the canonical
// dispatcher can put it on the dispatch result, the turn loop into the op's
// event log and tool_result row, and the session projection onto the card.
// Until this existed the only trace of a kernel block was the model-facing
// text in op-messages; the event log said "blocked" and nothing else, or, for
// a raw-rendered deny, "ok".

import type { KernelQuarantine, ToolBlockRecord, ToolResult } from "../types.js";
import { statusOf } from "../tools/result-helpers.js";

const REASON_MAX = 300;

export function blockRecordOf(result: ToolResult): ToolBlockRecord | undefined {
  if (statusOf(result) !== "blocked") return undefined;
  const md = result.metadata ?? {};
  const layer = typeof md.layer === "string" ? md.layer : "unknown";
  const layers = Array.isArray(md.layers) ? md.layers.filter((s): s is string => typeof s === "string") : undefined;
  const clearable = md.clearable === "declassify" ? ("declassify" as const) : undefined;
  const quarantine = md.quarantine && typeof md.quarantine === "object" ? (md.quarantine as KernelQuarantine) : undefined;
  const kernel = layer === "arikernel" || layers?.includes("arikernel") === true || quarantine !== undefined;
  const scope = clearable ? ("session-memory" as const) : quarantine ? ("operation" as const) : undefined;
  return {
    layer,
    ...(layers ? { layers } : {}),
    reason: (result.content.split("\n")[0] ?? "").slice(0, REASON_MAX),
    ...(clearable ? { clearable } : {}),
    ...(quarantine ? { quarantine } : {}),
    ...(scope ? { scope } : {}),
    notice: clearable ? "declassify-card" : kernel ? "kernel-notice" : "none",
  };
}

/** Stamp the record onto the tool message the model and the dispatcher get. */
export function carryBlockRecord(message: object, result: ToolResult): void {
  const block = blockRecordOf(result);
  if (block) (message as { _block?: ToolBlockRecord })._block = block;
}
