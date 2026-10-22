/**
 * Stored transcript → what the chat shows.
 *
 * Split out of session-message-log.ts: that
 * module owns reading and writing the log on disk; this owns the separate
 * question of which rows a PERSON should see and how a turn's assistant
 * fragments collapse into one bubble.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { Session, ToolBlockRecord, ToolResultStatus } from "../types.js";
import { isHarnessRow } from "../harness-rows.js";
import { parseResultHeader } from "../tools/result-helpers.js";
import { messageProvenance } from "./session-message-provenance.js";
import { mediaRefOf, toolMessageBlock, toolMessageMedia, toolMessageMetadata, toolMessageStatus, type ToolEndMedia } from "../tool-execution/tool-message-carry.js";

/**
 * The metadata a reloaded tool card renders from — the same bag the live
 * tool_end carries. The persisted `_metadata` (the tool message's carry,
 * message-convert.ts) is the whole answer, with the `_block` record's scalars
 * (layer / clearable / scope / quarantine) over it, since those are what the
 * block notice keys on. A row written before either existed still carries the
 * header's scalars for a block. Absent all three, the block is invisible on
 * reload, which is how the 2026-09-27 quarantine lost its control.
 */
function metadataOf(message: ChatCompletionMessageParam, block: ToolBlockRecord | undefined, rendered: string): Record<string, unknown> | undefined {
  const carried = toolMessageMetadata(message);
  if (block) {
    const { reason: _reason, notice: _notice, recovery: _recovery, ...md } = block;
    return { ...carried, ...md };
  }
  if (carried) return carried;
  const header = parseResultHeader(rendered);
  if (!header || header.status !== "blocked") return undefined;
  return header.meta;
}

/** The tool-result text a reloaded card carries. Cut at a line boundary: the
 *  chat scans it for `workspace/images/<file>` and `/images/<file>`, and a
 *  path cut mid-name became a second, broken image preview (2026-10-17). The
 *  live reducer (public/js/chat-stream-reducer.js) cuts the same way. */
export const UI_TOOL_RESULT_MAX_CHARS = 500;
export function uiToolResultText(result: string): string {
  return result.length > UI_TOOL_RESULT_MAX_CHARS
    ? result.slice(0, UI_TOOL_RESULT_MAX_CHARS).replace(/[^\n]*$/, "")
    : result;
}

/** When a message was said, in epoch ms, for the chat's time dividers; absent
 *  when the log does not know (a row whose recorded time is a later save's). */
function saidAt(message: object): number | undefined {
  const known = messageProvenance(message);
  if (!known?.createdAt || known.timeUnknown) return undefined;
  const at = Date.parse(known.createdAt);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * UI projection of a Session. Same model state, different shape: drops
 * `tool` rows, replaces `tool_calls` on assistants with a synthetic
 * `_tools` array the chat renderer turns into expandable tool cards.
 * Compaction summary stays as a leading `system` message (the UI knows
 * how to render that).
 *
 * Why a separate projection: model state and display state have different
 * requirements. The model needs full tool_calls / tool_result structure
 * across turns to chain follow-ups. The UI needs the visible conversation
 * plus enough tool-call breadcrumbs to rebuild the tool cards a returning
 * user expects to see (without this they vanish on chat-switch+back, when
 * hydrateChat overwrites the client-side `_tools`).
 *
 * Frontend-facing API endpoints serve this projection. Model-facing code
 * paths (`prepareAgentRequest`, `seedOpMessages`) read the rich form.
 */
export function projectSessionForUI(session: Session): Session {
  // Index tool rows by tool_call_id so we can attach results to the
  // assistant that triggered them. JSONL preserves order, so the latest
  // result for a given id is authoritative.
  const toolResults = new Map<string, { content: string; status: ToolResultStatus; metadata?: Record<string, unknown>; media?: ToolEndMedia }>();
  for (const m of session.messages) {
    if (m.role !== "tool") continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (m.tool_call_id) {
      toolResults.set(m.tool_call_id, {
        content,
        status: toolMessageStatus(m),
        metadata: metadataOf(m, toolMessageBlock(m), content),
        media: mediaRefOf(toolMessageMedia(m)),
      });
    }
  }

  type ToolEvent = { type: "start" | "end"; name: string; args?: Record<string, unknown>; result?: string; allowed?: boolean; status?: ToolResultStatus; metadata?: Record<string, unknown>; media?: ToolEndMedia };
  type UIAssistant = ChatCompletionMessageParam & { _tools?: ToolEvent[]; _at?: number };

  const messages: ChatCompletionMessageParam[] = [];
  // One assistant bubble per turn — the SAME shape the live UI persists
  // (promoteLiveToMessages emits one row per turn carrying ALL of the turn's
  // tool events in a single `_tools` array). The model often emits several
  // `assistant` entries for one turn (one carrying tool_calls, another carrying
  // narration text, a third the final answer); an earlier projection flushed a
  // separate bubble at EACH text entry, so a reloaded turn showed a little
  // "Agent activity" bar under every step instead of one long-running bar.
  // Accumulate BOTH the text fragments and the tool breadcrumbs across the
  // whole turn and emit exactly one consolidated bubble at the turn boundary.
  let pendingTools: ToolEvent[] = [];
  let pendingText: string[] = [];
  // The bubble is dated by the turn's first assistant row: when the reply began.
  let pendingAt: number | undefined;
  const flushTurn = () => {
    if (pendingTools.length === 0 && pendingText.length === 0) return;
    const out: UIAssistant = { role: "assistant", content: pendingText.join("\n\n") };
    if (pendingTools.length > 0) out._tools = pendingTools;
    if (pendingAt !== undefined) out._at = pendingAt;
    messages.push(out);
    pendingTools = [];
    pendingText = [];
    pendingAt = undefined;
  };

  for (const m of session.messages) {
    if (m.role === "tool") continue;
    // Harness rows (nudges) live in the transcript for the MODEL. The person
    // never said them, so the chat never shows them.
    if (isHarnessRow(m)) continue;
    if (m.role === "user") {
      // User message ends the prior assistant turn — flush its one bubble
      // (tools-only turns still emit, as an empty-content assistant with the
      // activity bar) before pushing the prompt.
      flushTurn();
      const at = saidAt(m);
      // A copy: the stored message is what providers are sent.
      messages.push(at === undefined ? m : ({ ...m, _at: at } as ChatCompletionMessageParam));
      continue;
    }
    if (m.role === "assistant") {
      if (pendingTools.length === 0 && pendingText.length === 0) pendingAt = saidAt(m);
      const tcalls = (m as unknown as { tool_calls?: Array<{ id: string; function?: { name: string; arguments: string } }> }).tool_calls;
      if (Array.isArray(tcalls)) {
        for (const tc of tcalls) {
          const name = tc.function?.name || "tool";
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          pendingTools.push({ type: "start", name, args });
          const { content: result, status, metadata, media } = toolResults.get(tc.id) ?? { content: "", status: "ok" as const };
          pendingTools.push({ type: "end", name, allowed: true, result: uiToolResultText(result), status, ...(metadata ? { metadata } : {}), ...(media ? { media } : {}) });
        }
      }
      const text = typeof m.content === "string" ? m.content : "";
      if (text) pendingText.push(text);
      continue;
    }
    // Non-user/assistant/tool row (e.g. a system message mid-thread): it ends
    // the current turn's accumulation, then passes through in place.
    flushTurn();
    messages.push(m);
  }
  flushTurn();
  return { ...session, messages };
}
