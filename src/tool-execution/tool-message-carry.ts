// What rides a tool message beside its rendered content. The model reads the
// text; the harness reads the carry: the envelope's status (`_status`), the
// block record (`_block`) and the media path (`_media`). One constructor
// builds every tool message the pipeline emits, so a reader never has to
// recover the status by parsing the header back out of the text — which is
// how a `[blocked]` with metadata was replayed as a success and a kernel
// block's control vanished on reload. The adapters rebuild provider messages
// from canonical rows, so the carry never reaches a model.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { KernelQuarantine, ToolBlockRecord, ToolResult, ToolResultStatus } from "../types.js";
import { isBlockLayer } from "../types.js";
import { BLOCKED_WITHOUT_RECOVERY, parseStatusHeader, renderToolResultForModel, statusOf } from "../tools/result-helpers.js";

const REASON_MAX = 300;

export interface ToolMessageCarry {
  _status: ToolResultStatus;
  _block?: ToolBlockRecord;
  _media?: ToolResult["_media"];
}

/** A tool message with its carry; the shape every reader below accepts. */
export type CarriedToolMessage = { content?: unknown } & Partial<ToolMessageCarry>;

/**
 * The record for a refusal, or for the control show_unblock_control re-surfaces
 * (an ok result whose layer is "quarantine-notice": the chat renders the same
 * notice from it, live and on reload). Undefined for every other result.
 */
export function blockRecordOf(result: ToolResult): ToolBlockRecord | undefined {
  const md = result.metadata ?? {};
  const refused = statusOf(result) === "blocked";
  if (!refused && md.layer !== "quarantine-notice") return undefined;
  const layer = isBlockLayer(md.layer) ? md.layer : "unknown";
  const layers = Array.isArray(md.layers) ? md.layers.filter(isBlockLayer) : undefined;
  const recovery = refused ? (typeof md.recovery === "string" && md.recovery ? md.recovery : BLOCKED_WITHOUT_RECOVERY) : undefined;
  const host = md.clearable === "allow-host" && typeof md.host === "string" && md.host ? md.host : undefined;
  const clearable = md.clearable === "declassify" ? ("declassify" as const) : host ? ("allow-host" as const) : undefined;
  const quarantine = md.quarantine && typeof md.quarantine === "object" ? (md.quarantine as KernelQuarantine) : undefined;
  const kernel = layer === "arikernel" || layers?.includes("arikernel") === true || quarantine !== undefined;
  const scope = clearable === "declassify" ? ("session-memory" as const) : quarantine ? ("operation" as const) : undefined;
  return {
    layer,
    ...(layers ? { layers } : {}),
    reason: (result.content.split("\n")[0] ?? "").slice(0, REASON_MAX),
    ...(recovery ? { recovery } : {}),
    ...(clearable ? { clearable } : {}),
    ...(host ? { host } : {}),
    ...(quarantine ? { quarantine } : {}),
    ...(scope ? { scope } : {}),
    ...(typeof md.deferredTo === "string" && md.deferredTo ? { deferredTo: md.deferredTo } : {}),
    notice: clearable === "declassify" ? "declassify-card" : clearable === "allow-host" ? "allow-host-card" : kernel ? "kernel-notice" : "none",
  };
}

/**
 * The tool message for a result: the rendered text for the model and the
 * carry for the harness. `content` overrides the rendering when the seam shows
 * the model something else (the single-image shortcut), never the carry.
 */
export function toolMessage(toolCallId: string, result: ToolResult, content: string = renderToolResultForModel(result)): ChatCompletionMessageParam {
  const message: ChatCompletionMessageParam & ToolMessageCarry = { role: "tool", tool_call_id: toolCallId, content, _status: statusOf(result) };
  const block = blockRecordOf(result);
  if (block) message._block = block;
  if (result._media) message._media = result._media;
  return message;
}

/**
 * The status of a tool message. Rows persisted before the carry existed
 * (2026-10-17) have only the rendered header, so the header is read for them
 * and for nothing else: every message the pipeline emits carries `_status`
 * (tool-message-carry.test.ts).
 */
export function toolMessageStatus(message: CarriedToolMessage): ToolResultStatus {
  if (message._status) return message._status;
  return parseStatusHeader(typeof message.content === "string" ? message.content : "");
}

export function toolMessageBlock(message: CarriedToolMessage): ToolBlockRecord | undefined {
  return message._block;
}

export function toolMessageMedia(message: CarriedToolMessage): ToolResult["_media"] {
  return message._media;
}

/** Statuses the dispatch boundary reports as a failure (`running` is a
 *  successful start). */
export function isFailureStatus(status: ToolResultStatus): boolean {
  return status !== "ok" && status !== "running";
}

/**
 * The result envelope a tool message stands for, rebuilt from its carry: the
 * single-call entry (dispatchSingleToolCall) and the MCP bridge return this,
 * where they used to parse the header. A refusal keeps the gate and the next
 * step its record carries.
 */
export function toolMessageResult(message: CarriedToolMessage): ToolResult {
  const content = typeof message.content === "string" ? message.content : "";
  const status = toolMessageStatus(message);
  const isError = isFailureStatus(status);
  const block = toolMessageBlock(message);
  if (status === "blocked") {
    const layer = block?.layer ?? "unknown";
    const recovery = block?.recovery ?? BLOCKED_WITHOUT_RECOVERY;
    return {
      content, isError, status,
      metadata: {
        layer, recovery,
        ...(block?.clearable ? { clearable: block.clearable } : {}),
        ...(block?.host ? { host: block.host } : {}),
        ...(block?.deferredTo ? { deferredTo: block.deferredTo } : {}),
      },
    };
  }
  return { content, isError, status };
}
