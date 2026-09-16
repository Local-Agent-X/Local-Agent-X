/**
 * Stored transcript → what the chat shows.
 *
 * Split out of session-message-log.ts (400-LOC source-hygiene ceiling): that
 * module owns reading and writing the log on disk; this owns the separate
 * question of which rows a PERSON should see and how a turn's assistant
 * fragments collapse into one bubble.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { Session, ToolResultStatus } from "../types.js";
import { isHarnessRow } from "../harness-rows.js";
import { parseStatusHeader } from "../tools/result-helpers.js";

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
  const toolResults = new Map<string, string>();
  for (const m of session.messages) {
    if (m.role !== "tool") continue;
    const id = (m as unknown as { tool_call_id?: string }).tool_call_id;
    const content = typeof m.content === "string" ? m.content : "";
    if (id) toolResults.set(id, content);
  }

  type ToolEvent = { type: "start" | "end"; name: string; args?: Record<string, unknown>; result?: string; allowed?: boolean; status?: ToolResultStatus };
  type UIAssistant = ChatCompletionMessageParam & { _tools?: ToolEvent[] };

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
  const flushTurn = () => {
    if (pendingTools.length === 0 && pendingText.length === 0) return;
    const out: UIAssistant = { role: "assistant", content: pendingText.join("\n\n") };
    if (pendingTools.length > 0) out._tools = pendingTools;
    messages.push(out);
    pendingTools = [];
    pendingText = [];
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
      messages.push(m);
      continue;
    }
    if (m.role === "assistant") {
      const tcalls = (m as unknown as { tool_calls?: Array<{ id: string; function?: { name: string; arguments: string } }> }).tool_calls;
      if (Array.isArray(tcalls)) {
        for (const tc of tcalls) {
          const name = tc.function?.name || "tool";
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          pendingTools.push({ type: "start", name, args });
          const result = toolResults.get(tc.id) || "";
          pendingTools.push({ type: "end", name, allowed: true, result: result.slice(0, 500), status: parseStatusHeader(result) });
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
