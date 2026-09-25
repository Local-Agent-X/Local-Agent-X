/**
 * The local wire's stable prefix: which rendered system-prompt sections stay
 * in `messages[0]` and which ride a trailing row instead.
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
 * head. What moves is what is rebuilt per op from per-turn inputs. The
 * situational digest already rides a trailing row for the same reason
 * (turn-loop/build-input.ts); this extends that mechanism to the prompt's
 * own per-op sections rather than inventing a second one.
 *
 * Every section id the builders emit is classified in exactly one of the two
 * sets below; local-prompt-split.test.ts scans the builders and fails on a
 * new id that is in neither, so a section added later cannot silently break
 * the prefix (tail) or silently change what the model reads as system (head).
 */
import type { RenderedPromptSection } from "../../context/system-prompt-builder.js";

/** Rebuilt per op from per-turn inputs; each one changes across messages. */
export const TRAILING_SECTION_IDS: ReadonlySet<string> = new Set([
  "context-block",
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
  "system-prompt-override",
  "core-identity",
  "runtime-context",
  "identity-names",
  "learned-protocol",
  "file-attachments",
  "app-manifest",
  "agents-md",
  "provider-hint",
  "tool-guidance",
  "recall-reflex",
  "project-catalog",
  "integrations",
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
