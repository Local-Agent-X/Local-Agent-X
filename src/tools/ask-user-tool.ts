/**
 * ask_user — the agent's one way to STOP and hand a decision back to the user.
 *
 * The failure this exists to remove: at a genuine fork ("production Clover
 * token, or sandbox first?") the agent had no way to end its turn on a
 * question. Every terminator in the turn loop
 * (canonical-loop/turn-loop/decide-outcome.ts) keys on the model having
 * FINISHED — end_turn, an all-silent turn, a committed mutation, no tools at
 * all — so a question asked mid-turn was just narration the loop drove right
 * past. The agent asked, read back its own tool result, guessed, and kept
 * building on the guess.
 *
 * The mechanism is deliberately NOT a blocking primitive. There is no wait, no
 * timeout, no durable "pending question" column, no approval card. This tool
 * does exactly one thing: it succeeds, and its success is the signal
 * decide-outcome uses to end the turn with `question` as the final answer the
 * user sees. The user replies as a normal chat message and the agent resumes
 * with that answer in context — the same path any follow-up message takes.
 *
 * Consequences of that design, all intentional:
 *   - The tool result the model reads on the NEXT turn is a receipt ("delivered,
 *     the turn ended here"), never the answer. The answer arrives as the user's
 *     message.
 *   - An empty/blank `question` is an ERROR, not a silent no-op: a failed call
 *     does not terminate the turn (decide-outcome requires resultStatus "ok"),
 *     so the model gets a correctable message instead of an op that ends
 *     showing the user nothing.
 *   - risk "safe" / kernel "internal": it mutates nothing, spawns nothing, and
 *     sends nothing off-box. The question lands in the user's own transcript.
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { err, ok } from "./result-helpers.js";

/** Longest question we will deliver. A "question" past this is a report the
 *  model should have written as its answer, not a fork the user can decide. */
const MAX_QUESTION_CHARS = 2000;

export const askUserTool: ToolDefinition = {
  name: "ask_user",
  description:
    "Stop and ask the user a question. This ENDS your turn: `question` becomes the last thing " +
    "the user sees, and their reply arrives as your next message. Use it at a genuine fork — when " +
    "guessing wrong would waste real work or make an irreversible choice (production vs sandbox " +
    "credentials, which of two accounts to charge, deleting something you cannot restore, a " +
    "requirement the request truly does not settle). Do NOT use it as a politeness reflex, to " +
    "confirm something you can infer from the conversation or the codebase, to ask permission for " +
    "work you were already told to do, or to report progress — asking when you could have found " +
    "out turns an autonomous run into an interrogation. One question per call; make it " +
    "self-contained, and include the options you see so the user can answer in a word.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The question, exactly as the user should read it. This IS your final answer for this " +
          "turn — nothing else you were about to say gets a chance to follow it. State the fork " +
          "and the options concretely.",
      },
    },
    required: ["question"],
  },
  // Reads nothing, writes nothing — safe to batch alongside other calls.
  readOnly: true,
  concurrencySafe: true,
  effect: { class: "read-only" },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question) {
      return err(
        "ask_user needs a non-empty `question`. Nothing was shown to the user and your turn did " +
        "NOT end — either call ask_user again with the actual question, or answer without asking.",
      );
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return err(
        `ask_user question is ${question.length} chars (max ${MAX_QUESTION_CHARS}). That is a ` +
        "report, not a fork. Say the long part as your normal answer and ask the short decision.",
      );
    }
    return ok(
      "Question delivered — your turn ends here and the user is reading it now. Do not continue, " +
      "do not guess the answer, and do not ask again: their reply arrives as your next message.",
    );
  },
};
