/**
 * The memory context a local chat's cached head was built with, held for the
 * rest of the chat.
 *
 * The context block's "stable" half (profile files, project brief,
 * core_memory) is rebuilt from the facts database every message, so its bytes
 * change whenever memory does: a `remember` call, a fact the end-of-turn
 * writer extracted, a reinforcement that moves a fact into the selection cut.
 * It sits in the system message, so on a hybrid model (qwen3.8, which resumes
 * only from checkpoints near the end of the last prompt) one changed line re-
 * read the whole ~34k-token prompt on the next message. Measured 2026-11-03:
 * a message after a `remember` call diverged at token 31,814 of 32,835.
 *
 * So the head keeps the block it was first built with, and the lines memory
 * gained since ride the message's recalled-context row, which stays in the
 * conversation (local-prompt-split.ts recalledContextText). Each line is told
 * once. Lines that left the block are not reported: a fact drops out when it
 * falls below the selection cut, or when the retrieval build degrades to the
 * profile files, and neither means it left memory; a corrected fact arrives
 * as a new line, which the row says supersedes the head. When the told lines
 * outgrow MAX_TOLD_LINES the head is rebuilt from current memory, one full
 * re-read, and the count starts over. The pin lives in this process: after a
 * restart the next message builds a new head, also one re-read.
 */

/** Lines a chat is told after its head was built, before the head is rebuilt. */
export const MAX_TOLD_LINES = 60;
const MAX_SESSIONS = 64;

interface Pin {
  /** The block the head was built with, byte for byte. */
  text: string;
  /** Every memory line the model has been given: the head's, plus each told since. */
  told: Set<string>;
  /** Lines told since the head was built. */
  toldSince: number;
}

const pins = new Map<string, Pin>();

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
}

function pinFresh(sessionId: string, text: string): { head: string; changes: string } {
  pins.delete(sessionId);
  pins.set(sessionId, { text, told: new Set(lines(text)), toldSince: 0 });
  while (pins.size > MAX_SESSIONS) pins.delete(pins.keys().next().value as string);
  return { head: text, changes: "" };
}

/**
 * The memory context for this message's head, and the lines memory gained
 * since the head was built ("" when none). `current` is the block rebuilt now.
 */
export function pinMemoryContext(sessionId: string, current: string): { head: string; changes: string } {
  const pin = pins.get(sessionId);
  if (!pin) return pinFresh(sessionId, current);
  const added = [...new Set(lines(current))].filter((l) => !pin.told.has(l));
  if (added.length === 0) return { head: pin.text, changes: "" };
  if (pin.toldSince + added.length > MAX_TOLD_LINES) return pinFresh(sessionId, current);
  for (const l of added) pin.told.add(l);
  pin.toldSince += added.length;
  return {
    head: pin.text,
    changes: ["<memory_changes>",
      "Memory gained these lines after the memory context in the system prompt was loaded for this chat. Where they conflict with it, these are current.",
      ...added, "</memory_changes>"].join("\n"),
  };
}

/** Test seam. */
export function _resetMemoryPinsForTests(): void {
  pins.clear();
}
