/**
 * A chunk worker's conversation, kept on disk between its rounds.
 *
 * A fix round goes back to the worker that built the chunk, with what it
 * already knows (handle-push-back.ts). That conversation lived in memory
 * only: a Pause, a Resume or a restart of LAX started the next round with a
 * worker that had to read the whole chunk again. It is saved here each time a
 * round ends, read when the chunk is picked up again, and dropped when the
 * chunk lands.
 *
 * It is the conversation as of the last round that ENDED. A worker stopped
 * in the middle of a round has no finished conversation for that round, so
 * the round starts again from the one before it, on the files it wrote.
 *
 * Kept in LAX's data folder, never in the project: it is the engine's state,
 * and a worker must not find and read another worker's conversation.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { pruneFinishedTurnToolResults } from "../../context-manager/prune-tool-results.js";

/** A conversation past this is not worth carrying: reading the chunk again costs less. */
const MAX_BYTES = 4 * 1024 * 1024;

function fileFor(projectDir: string, chunk: number): string {
  const key = createHash("sha256").update(resolve(projectDir).replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 16);
  return join(getLaxDir(), "auto-build", "worker-conversations", `${key}-c${chunk}.json`);
}

/** Keep `messages` as chunk `chunk`'s conversation. Never throws: a build does not fail over this. */
export function saveWorkerConversation(projectDir: string, chunk: number, messages: readonly ChatCompletionMessageParam[]): void {
  try {
    const text = JSON.stringify(messages);
    const path = fileFor(projectDir, chunk);
    if (text.length > MAX_BYTES) { rmSync(path, { force: true }); return; }
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text, "utf8");
  } catch { /* best effort: the next round then starts a fresh worker, as before */ }
}

/** The conversation kept for chunk `chunk`, or undefined when there is none that can be used. */
export function loadWorkerConversation(projectDir: string, chunk: number): ChatCompletionMessageParam[] | undefined {
  try {
    const path = fileFor(projectDir, chunk);
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    if (!parsed.every((m) => m && typeof m === "object" && typeof (m as { role?: unknown }).role === "string")) return undefined;
    return parsed as ChatCompletionMessageParam[];
  } catch {
    return undefined; // unreadable or half-written: start fresh
  }
}

/**
 * The conversation as the worker's next round is sent it: what it said and
 * did, with the output of its earlier tool calls stubbed (the chat lane's
 * finished-turn prune, context-manager/prune-tool-results.ts). Those rounds
 * are over; the files are on disk and a command can be run again. Carried
 * whole, GPT workers opened fix rounds at 150k to 250k tokens and re-sent
 * that on every call of the round (label-check-sol, 2026-11-26). A pure
 * function of the conversation, so the next round's prefix is the same bytes.
 */
export function carriedConversation(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  // Every row is from a finished round: the prune stubs what is before the last user row.
  const closed: ChatCompletionMessageParam = { role: "user", content: "" };
  return pruneFinishedTurnToolResults([...messages, closed]).slice(0, -1);
}

export function dropWorkerConversation(projectDir: string, chunk: number): void {
  try { rmSync(fileFor(projectDir, chunk), { force: true }); } catch { /* nothing to drop */ }
}
