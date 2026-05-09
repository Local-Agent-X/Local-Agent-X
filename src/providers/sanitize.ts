import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { stripSystemInjectionTags } from "../sanitize.js";

/** Sanitize tool result content to remove pseudo-system injection tags. */
export function sanitizeToolResults(results: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return results.map(r => {
    if (r.role !== "tool" || typeof r.content !== "string") return r;
    return { ...r, content: stripSystemInjectionTags(r.content) };
  });
}

/**
 * Strip ephemeral self-check / quality-gate / middleware-nudge user messages
 * before persisting a session.
 *
 * Two filter mechanisms (defense-in-depth):
 *  1. Structural — `_ephemeral: true` flag set by agent-loop/run.ts on every
 *     middleware nudge push. New nudges are auto-filtered without anyone
 *     having to remember to update a string list.
 *  2. Legacy strings — covers nudges that were saved before the flag existed,
 *     plus self-check / quality-gate messages that aren't routed through the
 *     middleware nudge path.
 *
 * The model still sees the nudge during the turn (it's in the in-memory
 * messages array). The flag only kicks in at persist + replay boundaries so
 * the chat transcript on reload doesn't show purple "You claimed..." bubbles
 * where tool calls used to render live.
 */
export function stripEphemeralMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return messages.filter((m) => {
    // Structural marker — set on every middleware nudge in agent-loop/run.ts
    if ((m as unknown as { _ephemeral?: boolean })._ephemeral === true) return false;

    if (m.role === "user" && typeof m.content === "string") {
      if (m.content.startsWith("[Self-check]")) return false;
      if (m.content.startsWith("Your previous response was empty.")) return false;
      if (m.content.startsWith("Tool errors occurred but you did not address them.")) return false;
      if (m.content.startsWith("You do NOT need approval.")) return false;
      // Action-claim / force-tool-use nudges. Listed by exact prefix because
      // older sessions on disk pre-date the _ephemeral flag — those messages
      // need to be filtered on load too.
      if (m.content.startsWith("You claimed to have created or scheduled")) return false;
      if (m.content.startsWith("You claimed to have added/updated/created/scheduled")) return false;
      if (m.content.startsWith("You claimed an action ")) return false;
      // NOTE: "SYSTEM: You have called ..." loop nudges are kept — the LLM must see them to stop looping
    }
    // Strip legacy empty-response placeholders so they don't pollute
    // future turns (breaks alternating-role expectation on Codex API).
    if (m.role === "assistant" && typeof m.content === "string") {
      if (m.content.includes("model returned an empty response") && m.content.length < 300) return false;
    }
    return true;
  });
}

/**
 * Sanitize a message history before sending it to a provider.
 * Strips orphaned tool_calls (assistant tool_calls without matching tool results)
 * and orphaned tool results (tool messages without matching assistant calls).
 *
 * The OpenAI Responses API in particular silently rejects requests with
 * malformed tool_call structure — the model returns zero output items, which
 * shows up as an empty response. This is the root cause of the bridge handler
 * returning empty placeholders even for benign messages like "hey".
 */
export function sanitizeHistory(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  type MsgRecord = Record<string, unknown>;
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    const rec = m as unknown as MsgRecord;
    if (m.role === "assistant" && rec.tool_calls) {
      for (const tc of rec.tool_calls as Array<{ id: string }>) callIds.add(tc.id);
    }
    if (m.role === "tool" && rec.tool_call_id) {
      resultIds.add(rec.tool_call_id as string);
    }
  }
  const orphanedCallIds = new Set([...callIds].filter((id) => !resultIds.has(id)));

  const out: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    const rec = m as unknown as MsgRecord;
    if (m.role === "assistant" && rec.tool_calls) {
      if (orphanedCallIds.size > 0) {
        const cleaned = (rec.tool_calls as Array<{ id: string }>).filter((tc) => !orphanedCallIds.has(tc.id));
        if (cleaned.length === 0) {
          if (m.content) out.push({ role: m.role, content: m.content } as ChatCompletionMessageParam);
        } else {
          out.push({ ...m, tool_calls: cleaned } as typeof m);
        }
      } else {
        out.push(m);
      }
    } else if (m.role === "tool") {
      const tid = rec.tool_call_id as string | undefined;
      if (tid && callIds.has(tid) && !orphanedCallIds.has(tid)) {
        out.push(m);
      }
    } else {
      out.push(m);
    }
  }

  // Coalesce consecutive same-role text messages. Multiple bridge messages
  // arriving back-to-back with no agent reply (3x "hey") create runs of
  // user-only messages that violate the alternating-role expectation Codex
  // enforces and cause empty responses.
  const coalesced: ChatCompletionMessageParam[] = [];
  for (const m of out) {
    const last = coalesced[coalesced.length - 1];
    if (
      last &&
      last.role === m.role &&
      (m.role === "user" || m.role === "assistant") &&
      typeof last.content === "string" &&
      typeof m.content === "string" &&
      !(last as unknown as MsgRecord).tool_calls &&
      !(m as unknown as MsgRecord).tool_calls
    ) {
      // Merge into the previous message
      (last as { content: string }).content = `${last.content}\n${m.content}`;
      continue;
    }
    coalesced.push(m);
  }
  return coalesced;
}

/**
 * Truncate a long history to a working window, with an optional summary header.
 * Cuts at the nearest user message so we never split a tool-call/tool-result pair.
 *
 * Preserves a leading `system` message verbatim (e.g. a compaction summary
 * from /api/compact). Without that special-case, truncate's own summary
 * loop ignores system rows and the explicit compaction content gets
 * silently dropped from `old` when a session grows past maxKeep
 * post-compaction.
 */
export function truncateHistory(messages: ChatCompletionMessageParam[], maxKeep: number = 30): ChatCompletionMessageParam[] {
  let preservedLeader: ChatCompletionMessageParam | null = null;
  let body: ChatCompletionMessageParam[] = messages;
  if (body[0]?.role === "system") {
    preservedLeader = body[0];
    body = body.slice(1);
  }

  if (body.length <= maxKeep) {
    return preservedLeader ? [preservedLeader, ...body] : body;
  }

  const targetIdx = body.length - maxKeep;
  // Find nearest user message at or after target
  let cutIdx = targetIdx;
  for (let i = targetIdx; i < body.length; i++) {
    if (body[i].role === "user") { cutIdx = i; break; }
  }
  if (cutIdx >= body.length) {
    for (let i = targetIdx; i >= 0; i--) {
      if (body[i].role === "user") { cutIdx = i; break; }
    }
  }

  // Walk cutIdx backward if we'd split a tool_call/tool_result pair
  // (assistant with tool_calls must be followed by its tool results)
  if (cutIdx > 0 && body[cutIdx - 1]?.role === "assistant") {
    const prev = body[cutIdx - 1] as unknown as Record<string, unknown>;
    if (prev.tool_calls && Array.isArray(prev.tool_calls)) {
      // The assistant before the cut has tool_calls — include it and its results
      cutIdx = cutIdx - 1;
      // Also include all following tool result messages
      while (cutIdx + 1 < body.length && body[cutIdx + 1]?.role === "tool") {
        // These will be included in 'recent' anyway since cutIdx moved back
      }
    }
  }
  // Also skip forward past any orphaned tool results at the start of recent
  while (cutIdx < body.length && body[cutIdx]?.role === "tool") {
    cutIdx++;
  }

  const old = body.slice(0, cutIdx);
  const recent = body.slice(cutIdx);

  // Summarize older messages so the model knows there was prior context.
  // CRITICAL: do NOT use "User: X / Agent: Y" format here — the model will
  // mimic that format in its OWN output and leak fake "User: ..." lines into
  // its replies. Wrap in XML tags instead (the system prompt already tells
  // the model XML-tagged blocks are reference context, not output to echo).
  const summaryLines: string[] = [];
  for (const m of old) {
    if (m.role === "user" && typeof m.content === "string") {
      summaryLines.push(`<prior_user>${m.content.slice(0, 150).replace(/\n/g, " ")}</prior_user>`);
    } else if (m.role === "assistant" && typeof m.content === "string") {
      const firstLine = m.content.split("\n").filter((l) => l.trim())[0] || "";
      summaryLines.push(`<prior_assistant>${firstLine.slice(0, 150)}</prior_assistant>`);
    }
  }
  const summary = `<prior_conversation count="${old.length}">\n${summaryLines.join("\n")}\n</prior_conversation>`;

  const autoSummary: ChatCompletionMessageParam = { role: "system", content: summary } as ChatCompletionMessageParam;
  return preservedLeader ? [preservedLeader, autoSummary, ...recent] : [autoSummary, ...recent];
}
