/**
 * Consent the user already gave in the chat, for the irreversible floor
 * (approval-decision.ts). The agent asks "delete the stale branch
 * agent/field-agent-1-mvohb7r0?", the user answers "Approved to remove it",
 * and a card asking the same question again only waits for someone to come
 * back to the desktop: it timed out, and the delete never ran (2026-10-26).
 *
 * The rule is narrow on purpose. The user's latest message is a plain yes with
 * no hedge in it, the command is ONE command (no chain to slip a second act
 * past the yes), and every target it acts on (the words that are not the
 * program, its git subcommand or a flag) was named in the agent's message the
 * user answered, or in the user's own. A yes to something the agent did not
 * name is not consent to it.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { currentHumanText } from "./unnamed-delete-gate.js";
import { splitShellSegments, tokenizeCommand } from "../security/layer/shell-lex.js";

/** What was said around this call: the user's latest message and the
 *  agent's message right before it, the question the user answered. */
export interface ChatTurn {
  user: string;
  assistant?: string;
}

const YES =
  /^\s*(?:yes|yep|yeah|sure|ok(?:ay)?|go ahead|do it|approved?|confirm(?:ed)?|proceed|go for it)\b|\b(?:approved? to|go ahead and)\s+\w+|^\s*(?:delete|remove|drop|force[- ]delete)\s+(?:it|them|that|those)\b/i;
const HEDGE = /\b(?:no|not|don'?t|do not|wait|stop|hold on|cancel|never|instead)\b|\?/i;

/** The user's latest message and the agent message it answered. */
export function chatTurnOf(priorMessages: readonly ChatCompletionMessageParam[] | undefined): ChatTurn {
  const user = currentHumanText(priorMessages);
  if (!user || !priorMessages) return { user };
  let i = priorMessages.length - 1;
  while (i >= 0 && !(priorMessages[i].role === "user" && priorMessages[i].content === user)) i--;
  for (let j = i - 1; j >= 0; j--) {
    const m = priorMessages[j];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return { user, assistant: m.content };
  }
  return { user };
}

/** The words a command acts on: not the program, its git subcommand, or a flag. */
function targetsOf(command: string): string[] | null {
  const parts = splitShellSegments(command).map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 1) return null;
  const words = tokenizeCommand(parts[0]).filter((w) => !/^\w+=/.test(w));
  const program = (words.shift() ?? "").toLowerCase();
  const sub = program === "git" ? words.findIndex((w) => !w.startsWith("-")) : -1;
  if (sub >= 0) words.splice(sub, 1);
  return words.filter((w) => !w.startsWith("-"));
}

/** `target` appears as a whole path-like word: "dist" is not named by "distribution". */
function namedAsWord(text: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w./~-])${escaped}(?:$|[^\\w./~-])`, "i").test(text);
}

export function consentedInChat(command: string, said: ChatTurn | undefined): boolean {
  if (!said || !YES.test(said.user) || HEDGE.test(said.user)) return false;
  const targets = targetsOf(command);
  if (!targets || targets.length === 0) return false;
  const named = `${said.assistant ?? ""}\n${said.user}`;
  return targets.every((t) => namedAsWord(named, t));
}
