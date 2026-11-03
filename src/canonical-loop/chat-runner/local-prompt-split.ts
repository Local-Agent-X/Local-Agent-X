/**
 * The local wire's stable prefix: which rendered system-prompt sections stay
 * in `messages[0]` and which ride a row of their own after the user's message
 * (recalledContextText below).
 *
 * A local runtime caches the prompt by TOKEN PREFIX of the rendered chat
 * template, and the template renders the tool schemas after the system text.
 * So a section that changes between two user messages — recalled memory,
 * a notification, a turn directive — does not cost its own size: it re-
 * prefills everything after itself, tools and history included. Measured on
 * qwen3.6:27b: 30-37k tokens at every user message, the whole prompt
 * (EXP-12, docs/harness/HARNESS_LOG.md).
 *
 * The rule is by VOLATILITY, not by the builder's static/dynamic type: the
 * riders, the file-access notice, the channel context and the canary block
 * are typed dynamic but are byte-stable for a session, so they stay in the
 * head. What moves is what is rebuilt per op from per-turn inputs.
 *
 * Every section id the builders emit is classified in exactly one of the two
 * sets below; local-prompt-split.test.ts scans the builders and fails on a
 * new id that is in neither, so a section added later cannot silently break
 * the prefix (tail) or silently change what the model reads as system (head).
 */
import type { RenderedPromptSection } from "../../context/system-prompt-builder.js";
import type { PreparedAgentRequest } from "../../agent-request/types.js";
import { modelStablePrefix } from "../../local-runtimes/model-profile.js";
import { RECALLED_CONTEXT_CLOSE, RECALLED_CONTEXT_OPEN } from "../../harness-text.js";
import { pinMemoryContext } from "./local-memory-pin.js";

/** Rebuilt per op from per-turn inputs; each one changes across messages. */
export const TRAILING_SECTION_IDS: ReadonlySet<string> = new Set([
  "context-block-volatile",
  "relevant-memories",
  "smart-context",
  "memory-orchestrator",
  "notifications",
  "background-completions",
  "memory-curate",
  "turn-directive",
  "short-reply-context",
]);

/** Byte-stable for a session (or for the process), whatever their type. */
export const HEAD_SECTION_IDS: ReadonlySet<string> = new Set([
  // The memory context's stable half: profile files, project brief and
  // core_memory (memory/context.ts buildContextBlockParts). It rode the tail
  // whole until 2026-11-02, so its ~4.5k tokens were re-read with every
  // message. Rebuilt per message it still changes whenever memory does, so
  // the head holds the chat's first one (local-memory-pin.ts).
  "context-block",
  "system-prompt-override",
  "core-identity",
  "runtime-context",
  "identity-names",
  "learned-protocol",
  "file-attachments",
  "app-manifest",
  "agent-rules",
  "provider-hint",
  "tool-guidance",
  "recall-reflex",
  "project-catalog",
  "integrations",
  "project-rules", // a code session's AGENTS.md (context/project-agents-md.ts): the file's bytes, unchanged turn to turn
  "project-documents", // a chat project's documents in full (memory/project-docs/full-text.ts): unchanged until a document is
  "channel-context",
  "bridge-context",
  "canary",
  "file-access",
  "provider-rider",
  "model-family-rider",
  // The folded compaction summary. It changes only when a compaction lands,
  // and that is one miss per compaction — the ordinary price of compacting.
  "system-history",
]);

export interface SplitPrompt {
  /** The system message: every head section, in the builder's order. */
  head: string;
  /** The trailing row's body, or "" when no tail section rendered this op. */
  tail: string;
  tailIds: string[];
}

/** A base-prompt part id is `core-identity/<heading>`; the family is the head. */
function family(id: string): string {
  return id.includes("/") ? id.slice(0, id.indexOf("/")) : id;
}

type SplitInput = Pick<PreparedAgentRequest, "provider" | "model" | "renderedPromptSections">;

/** One split per request: the memory pin below is told each line once, so the
 *  adapter and the op seed must read the same result, not compute two. */
const splits = new WeakMap<SplitInput, SplitPrompt | null>();

/** This request's split, or null when its model keeps one system message:
 *  on for every local model unless its profile opts out; every cloud
 *  provider keeps one. Both the adapter (the head) and the op seed (the
 *  tail's row) read it, from the same final sections. The memory context in
 *  the head is the one the chat (`sessionId`) started with
 *  (local-memory-pin.ts); what memory gained since leads the tail. */
export function localPromptSplit(prepared: SplitInput, sessionId: string): SplitPrompt | null {
  if (splits.has(prepared)) return splits.get(prepared) ?? null;
  let split: SplitPrompt | null = null;
  if (prepared.provider === "local" && modelStablePrefix(prepared.model, { provider: prepared.provider })) {
    const sections = [...prepared.renderedPromptSections];
    const at = sections.findIndex((s) => s.id === "context-block");
    let changes = "";
    if (at >= 0) {
      const pinned = pinMemoryContext(sessionId, sections[at].text);
      sections[at] = { ...sections[at], text: pinned.head };
      changes = pinned.changes;
    }
    split = splitPromptForStablePrefix(sections);
    if (changes) split = { ...split, tail: `${changes}\n\n${split.tail}`, tailIds: ["memory-changes", ...split.tailIds] };
  }
  splits.set(prepared, split);
  return split;
}

/**
 * The tail as the history row that carries it, or null when nothing rendered.
 *
 * It is a row OF THE CONVERSATION, not of one request: seeded right after the
 * user's message when the op starts (seed-messages.ts), saved with the turn
 * (recall-carry.ts withRecallCarried keeps it instead of building its own),
 * and replayed in that place on every later message. So the next message's
 * prompt starts with this one's, byte for byte. Sent per request instead, it
 * was dropped from the next one, and a hybrid model (qwen3.8, 2026-11-02),
 * which resumes only from checkpoints near the end of the last prompt, re-read
 * the whole 37k-token prompt for every message: 26-30 s before the first
 * word, against ~1 s to write the reply.
 */
export function recalledContextText(tail: string): string | null {
  const body = tail.trim();
  return body ? `${RECALLED_CONTEXT_OPEN}\n${body}\n${RECALLED_CONTEXT_CLOSE}` : null;
}

export function splitPromptForStablePrefix(sections: readonly RenderedPromptSection[]): SplitPrompt {
  const head: string[] = [];
  const tail: string[] = [];
  const tailIds: string[] = [];
  for (const section of sections) {
    if (TRAILING_SECTION_IDS.has(family(section.id))) {
      tail.push(section.text);
      tailIds.push(section.id);
    } else {
      head.push(section.text);
    }
  }
  return { head: head.join(""), tail: tail.join(""), tailIds };
}
