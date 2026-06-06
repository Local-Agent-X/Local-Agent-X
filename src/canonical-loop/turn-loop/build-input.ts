// Turn input assembly. Reads op_messages + the prior turn's providerState,
// and folds in any pending redirect snapshot taken before turn_started.
// Pure read — no writes, no events; the orchestrator owns ordering.

import type { TurnInput } from "../adapter-contract.js";
import type { CanonicalMessage } from "../contract-types.js";
import type { RedirectInstruction } from "../types.js";
import type { Op } from "../../ops/types.js";
import { readLatestOpTurn, readOpMessages } from "../store.js";
import { getToolsForOp } from "../runtime.js";
import { readOp } from "../../ops/op-store.js";
import { buildSituationalAwareness } from "./situational-awareness.js";

export function buildTurnInput(
  op: Op,
  turnIdx: number,
  pendingRedirect: RedirectInstruction | null,
): TurnInput {
  const history = readOpMessages(op.id);
  const messages: CanonicalMessage[] = collapseAdjacentUserMessages(
    history.map(m => ({
      messageId: m.messageId,
      role: m.role,
      content: m.content,
      turnIdx: m.turnIdx,
      seqInTurn: m.seqInTurn,
      createdAt: m.createdAt,
    })),
  );
  const prior = readLatestOpTurn(op.id);
  // Tools come from the per-op registry (chat-runner registers them on
  // submit; legacy worker-pool ops don't register and get []). Without
  // this, the adapter never tells the model about its tool surface and
  // tool-needing chats degrade to "I'm in planning mode" responses.
  const input: TurnInput = {
    opId: op.id,
    turnIdx,
    messages,
    providerState: prior?.providerState,
    tools: getToolsForOp(op.id),
  };
  if (pendingRedirect) input.pendingRedirect = pendingRedirect;

  // Ephemeral situational-awareness digest. Interactive lane only (chat +
  // voice) — background/build workers have their own evidence-history gates
  // and we don't want to perturb their soak behavior. Prepended to the turn's
  // last user message so it rides into every adapter (all replay
  // input.messages) without being persisted to op_messages. Recomputed each
  // turn; never accumulates.
  if (op.lane === "interactive") {
    const digest = buildSituationalAwareness(op, turnIdx);
    if (digest) input.messages = prependDigestToLastUser(input.messages, digest);
  }

  return input;
}

export function readPendingRedirect(opId: string): RedirectInstruction | null {
  const fresh = readOp(opId);
  return fresh?.canonical?.redirectInstruction ?? null;
}

// Merge adjacent same-role user messages (neither carrying images) into one
// before the model sees them. Two paths produce them: a rapid double-send
// (the user hits enter twice), and a retracted-hallucination turn whose false
// assistant text was dropped, leaving the question adjacent to the corrective
// nudge. Anthropic's API rejects consecutive same-role messages, so collapsing
// here keeps every adapter's replay valid. op_messages on disk is untouched —
// this only shapes the per-turn model view. Image-bearing user rows are left
// standalone so their attachment semantics survive.
export function collapseAdjacentUserMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && m.role === "user" && !hasImages(prev.content) && !hasImages(m.content)) {
      out[out.length - 1] = { ...prev, content: { text: joinUserText(prev.content, m.content) } };
      continue;
    }
    out.push(m);
  }
  return out;
}

// Prepend the situational-awareness digest to the text of the last user
// message, ephemerally. We target the last user row (not a trailing append)
// so we never create consecutive user messages and the model reads the
// context immediately before the request it's answering. Continuation turns
// (last row is assistant/tool_result) target the most recent user message
// earlier in the array — the model re-reads the digest as it keeps working.
// Returns a new array; the matched row is shallow-copied so op_messages and
// other readers are untouched.
function prependDigestToLastUser(messages: CanonicalMessage[], digest: string): CanonicalMessage[] {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { idx = i; break; }
  }
  if (idx === -1) return messages;

  const target = messages[idx];
  const existing = userText(target.content);
  const merged = `${digest}\n\n${existing}`;
  const nextContent = hasImages(target.content)
    ? { ...(target.content as Record<string, unknown>), text: merged }
    : { text: merged };

  const out = messages.slice();
  out[idx] = { ...target, content: nextContent };
  return out;
}

function hasImages(content: unknown): boolean {
  return (
    !!content &&
    typeof content === "object" &&
    Array.isArray((content as { images?: unknown }).images) &&
    (content as { images: unknown[] }).images.length > 0
  );
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const t = (content as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

function joinUserText(a: unknown, b: unknown): string {
  return [userText(a), userText(b)].filter(s => s.length > 0).join("\n\n");
}
