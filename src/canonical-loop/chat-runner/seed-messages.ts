// Pre-seed `op_messages` with the prepared conversation history followed by
// the current user message. Runs BEFORE `canonicalLoopEntry` so the loop's
// worker, on first turn, sees the full history instead of just the default
// `seedInitialUserMessage` rendering.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { PreparedAgentRequest } from "../../agent-request/types.js";
import type { OpMessageRow } from "../types.js";
import { appendOpMessage } from "../store.js";
import { messageRoleToCanonicalRole, extractTextContent } from "./message-convert.js";
import { mapUploadsRef } from "../../workspace/paths.js";

// ── Bounded history-image revival ──
//
// Reviving a photo from session history makes its bytes ride EVERY request
// for as long as the row stays inside the history keep-window (40 web / 30
// bridge rows) — an unbounded revival turns one oversized upload into a
// poisoned window where every request, including text-only asks, 400s on the
// provider's per-image cap for ~20 turns. So revival is bounded HERE, the one
// seam that revives (no second policy point):
//   - bytes only for the MOST RECENT occurrence of each unique image url,
//   - at most REVIVED_HISTORY_IMAGE_MAX_COUNT unique images per request,
//   - each at most REVIVED_HISTORY_IMAGE_MAX_BYTES (statted BEFORE any read),
// and every older/excess/oversized occurrence degrades to a short text
// placeholder so the model still knows an image was there. The CURRENT
// message's first-send images (prepared.images below) are deliberately not
// gated — that unconditional read predates this seam.
export const REVIVED_HISTORY_IMAGE_MAX_COUNT = 6;
export const REVIVED_HISTORY_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

type HistoryImage = { name: string; url: string; filePath?: string };

/** A user row's `images` prop, normalized: url required, same-row exact
 *  duplicates collapsed, filePath restored from the "/uploads/<f>" url via
 *  mapUploadsRef — the SAME single-source mapping file tools and the
 *  security gate resolve attachment refs with. */
function historyImagesOf(msg: ChatCompletionMessageParam): HistoryImage[] {
  const raw = (msg as ChatCompletionMessageParam & { images?: unknown }).images;
  if (!Array.isArray(raw)) return [];
  const out: HistoryImage[] = [];
  const seen = new Set<string>();
  for (const im of raw) {
    if (!im || typeof im !== "object") continue;
    const url = String((im as { url?: unknown }).url ?? "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const name = String((im as { name?: unknown }).name ?? "");
    const stored = (im as { filePath?: unknown }).filePath;
    const filePath =
      typeof stored === "string" && stored ? stored : mapUploadsRef(url) ?? undefined;
    out.push({ name, url, ...(filePath ? { filePath } : {}) });
  }
  return out;
}

/** Decoded byte size of the image, or null when it cannot be statted — a
 *  null flows through so the shared converter emits its standard
 *  unreadable-attachment note (the single surfacer for that failure). */
function imageByteSize(img: HistoryImage): number | null {
  if (img.url.startsWith("data:")) {
    const b64 = img.url.slice(img.url.indexOf(",") + 1);
    return Math.floor((b64.length * 3) / 4);
  }
  if (!img.filePath) return null;
  try {
    return statSync(img.filePath).size;
  } catch {
    return null;
  }
}

/** rowIdx → urls that get real bytes at that row. Most recent unique urls
 *  win the budget; a url repeated across rows revives only at its LAST row. */
function buildRevivalPlan(history: readonly ChatCompletionMessageParam[]): Map<number, Set<string>> {
  const lastRowOf = new Map<string, number>();
  history.forEach((msg, i) => {
    if (messageRoleToCanonicalRole(msg.role) !== "user") return;
    for (const img of historyImagesOf(msg)) lastRowOf.set(img.url, i);
  });
  const plan = new Map<number, Set<string>>();
  let budget = REVIVED_HISTORY_IMAGE_MAX_COUNT;
  for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
    const msg = history[i];
    if (messageRoleToCanonicalRole(msg.role) !== "user") continue;
    for (const img of historyImagesOf(msg)) {
      if (budget <= 0) break;
      if (lastRowOf.get(img.url) !== i) continue;
      let set = plan.get(i);
      if (!set) {
        set = new Set();
        plan.set(i, set);
      }
      set.add(img.url);
      budget -= 1;
    }
  }
  return plan;
}

export function seedOpMessages(opId: string, prepared: PreparedAgentRequest, currentMessage: string): void {
  let seqInTurn = 0;
  const turnIdx = 0;
  const revivalPlan = buildRevivalPlan(prepared.cleanHistory);

  // Canonical op_messages has no system role, so the loop below drops every
  // `role:"system"` row in cleanHistory. Those rows carry the /api/compact
  // summary and truncateHistory's digest — real prior context that is NOT in
  // prepared.systemPrompt when request preparation returns. createChatOp folds
  // them before telemetry persistence; seeding must not mutate the prompt.
  for (const [rowIdx, msg] of prepared.cleanHistory.entries()) {
    const role = messageRoleToCanonicalRole(msg.role);
    if (!role) continue;
    const text = extractTextContent(msg.content);

    // Carry tool_calls through on assistant messages. The codex adapter's
    // convertMessages reads `content.toolCalls` and emits function_call
    // items in the API input; without this round-trip, a session whose
    // history includes a tool-using turn surfaces orphan
    // function_call_outputs ("No tool call found for function call output
    // with call_id ..." 400s on Codex). The tool_call's id is the compound
    // call_id|item_id encoded by codex-message-convert.
    let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
    if (role === "assistant") {
      const m = msg as ChatCompletionMessageParam & {
        tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
      };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        toolCalls = m.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        }));
      }
    }

    // User rows round-tripped from session.messages carry attachments on a
    // nonstandard `images` prop holding {name, url} — opMessageRowToChatParam
    // strips filePath for the UI projection. A caption-less photo row
    // therefore arrived here with text:"" and fell to the emptiness filter
    // below: the model lost sight of an image it was shown a turn ago.
    // Revive those rows under the bounded plan above: the winners get real
    // bytes back (the shared converter re-reads them per request, or emits
    // its standard unreadable-attachment note for a pruned upload); every
    // older/excess/oversized occurrence becomes a text placeholder so the
    // row still survives, non-empty, without ballooning every request.
    let images: PreparedAgentRequest["images"] | undefined;
    let imagePlaceholders = "";
    if (role === "user") {
      const all = historyImagesOf(msg);
      if (all.length > 0) {
        const reviveUrls = revivalPlan.get(rowIdx);
        const revived: PreparedAgentRequest["images"] = [];
        const placeholders: string[] = [];
        for (const img of all) {
          const label = img.name || "image";
          if (!reviveUrls || !reviveUrls.has(img.url)) {
            placeholders.push(`[Image ${label} shown earlier in this conversation]`);
            continue;
          }
          const size = imageByteSize(img);
          if (size !== null && size > REVIVED_HISTORY_IMAGE_MAX_BYTES) {
            placeholders.push(`[Image ${label} omitted from history: too large to resend]`);
            continue;
          }
          revived.push({ name: img.name, url: img.url, ...(img.filePath ? { filePath: img.filePath } : {}) });
        }
        if (revived.length > 0) images = revived;
        if (placeholders.length > 0) imagePlaceholders = placeholders.join("\n");
      }
    }

    // Skip empty assistant rows ONLY when there are also no tool calls —
    // a tool-only assistant turn (no text, just function calls) is
    // structurally important for Codex pairing and must be persisted.
    // Same rule applies to tool_result rows: a tool message with empty
    // text but a real tool_call_id is still load-bearing — dropping it
    // orphans the matching assistant tool_call on the next Codex turn,
    // surfacing as the "No tool output found for function call X" 400
    // error. So preserve tool_result rows whenever they carry a
    // tool_call_id, regardless of text content.
    const isToolResultWithId = role === "tool_result" && (msg as ChatCompletionMessageParam & { tool_call_id?: string }).tool_call_id;
    if (!text && !toolCalls && !isToolResultWithId && !images && !imagePlaceholders) continue;

    // For tool_result rows, embed tool_call_id inside the content payload
    // (canonical OpMessageRow has a free-form `content` field; the adapter
    // reads tool_call_id from there when converting to provider messages).
    let content: unknown = { text };
    if (role === "tool_result") {
      const toolMsg = msg as ChatCompletionMessageParam & { tool_call_id?: string };
      if (toolMsg.tool_call_id) content = { text, toolCallId: toolMsg.tool_call_id };
    }
    if (role === "assistant" && toolCalls) {
      content = { text, toolCalls };
    }
    // Same content shape as the current-message row below — adapters extract
    // `images` and hand them to the shared provider converters. Placeholder
    // lines ride the row's text so a fully-placeholdered photo row is still
    // a non-empty user row, never the empty-text 400 class.
    if (role === "user" && (images || imagePlaceholders)) {
      const combined = imagePlaceholders ? (text ? `${text}\n${imagePlaceholders}` : imagePlaceholders) : text;
      content = images ? { text: combined, images } : { text: combined };
    }

    const row: OpMessageRow = {
      messageId: `hist-${opId}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
      opId,
      turnIdx,
      seqInTurn,
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    appendOpMessage(row);
    seqInTurn += 1;
  }

  // Current user message — last in the seed so the model sees it as the
  // "ask". seedInitialUserMessage is a no-op when op_messages is non-empty,
  // so this row replaces its default behavior with our prepared payload.
  // Image attachments ride on the same content payload — adapters extract
  // `images` and convert to their provider's wire format (OpenAI multi-
  // part for OpenAI-compat, image content blocks for Anthropic).
  const userContent: { text: string; images?: PreparedAgentRequest["images"] } = { text: currentMessage };
  if (prepared.images && prepared.images.length > 0) userContent.images = prepared.images;
  appendOpMessage({
    messageId: `um-${opId}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
    opId,
    turnIdx,
    seqInTurn,
    role: "user",
    content: userContent,
    createdAt: new Date().toISOString(),
  });
}
