// Turn input assembly. Reads op_messages + the prior turn's providerState,
// and folds in any pending redirect snapshot taken before turn_started.
// Pure read — no writes, no events; the orchestrator owns ordering.

import type { TurnInput } from "../adapter-contract.js";
import type { CanonicalMessage } from "../contract-types.js";
import type { ProviderStateEnvelope, RedirectInstruction } from "../types.js";
import type { Op } from "../../ops/types.js";
import { readLatestOpTurn, readOpMessages } from "../store.js";
import { lastTurnUsage } from "../op-usage.js";
import { getToolsForOp, getOpBaselineTokens } from "../runtime.js";
import { readOp } from "../../ops/op-store.js";
import { resolveOpModel } from "../op-model.js";
import { buildSituationalAwareness } from "./situational-awareness.js";
import { compactHistory } from "./compact-history.js";
import { getSessionBaselineTokens } from "../session-baseline.js";
import { isAnthropicModel } from "../../context-manager/effective-window.js";
import { isRuntimeFailoverBoundary } from "../../ops/target-identity.js";

export async function buildTurnInput(
  op: Op,
  turnIdx: number,
  pendingRedirect: RedirectInstruction | null,
): Promise<TurnInput> {
  const history = readOpMessages(op.id);
  let messages: CanonicalMessage[] = collapseAdjacentUserMessages(
    history.map(m => ({
      messageId: m.messageId,
      role: m.role,
      content: m.content,
      turnIdx: m.turnIdx,
      seqInTurn: m.seqInTurn,
      createdAt: m.createdAt,
    })),
  );
  // Compact older history when near the model's context window, before any
  // adapter sees it. Ephemeral (never persisted to op_messages), recomputed each
  // turn, and a no-op under threshold. Runs on every lane — long background /
  // agent ops are exactly where the full-replay history overruns the window.
  // Sizing is anchored on the last turn's REAL provider usage when available
  // (lastTurnUsage never throws; null → pure estimate inside compactHistory).
  const model = resolveOpModel(op);
  let viewCompacted = false;
  if (model) {
    // Baseline floor: the system prompt + tool manifest (+ memory + the CLI
    // subprocess's own system/MCP wrapping) the adapter sends OUTSIDE `messages`
    // — invisible to the pure token estimate. Feeding it in makes the chat path
    // size against the REAL request, so compaction fires before baseline +
    // conversation overruns the window instead of dying on "prompt too long".
    // The value is the session's REAL observed baseline (O(1) cache, seeded from
    // clean tool-less turns at commit); string estimate as first-message
    // fallback. Passed unconditionally: getContextStatus adds it ONLY on the
    // pure-estimate branch, so a mapped anchor (which already includes the
    // baseline) ignores it — and an UNMAPPABLE anchor still gets the floor.
    // Kill-switch: LAX_CONTEXT_BASELINE=0.
    // Scoped to chat_turn ops: the session baseline cache holds only the
    // interactive-chat tool surface, and the observed death is on that path.
    const baselineTokens = (process.env.LAX_CONTEXT_BASELINE !== "0" && op.type === "chat_turn" && isAnthropicModel(model))
      ? (getSessionBaselineTokens(op.canonical?.sessionId) ?? getOpBaselineTokens(op.id))
      : 0;
    // sessionBacked gates only the summary's recall-HINT line: recall confines
    // reads to the caller's session, so a session-less op would get a refusal.
    const compacted = await compactHistory(
      messages, model, lastTurnUsage(op.id), op.id, baselineTokens,
      Boolean(op.canonical?.sessionId),
    );
    messages = compacted.messages;
    viewCompacted = compacted.compacted;
  }
  const prior = readLatestOpTurn(op.id);
  const descriptor = op.runtimeDescriptor?.kind === "delegated-op"
    && op.runtimeDescriptor.adapter === "provider-exact"
    ? op.runtimeDescriptor
    : null;
  const crossedRuntimeBoundary = !!descriptor && isRuntimeFailoverBoundary(op, descriptor);
  // Tools come from the per-op registry (chat-runner registers them on
  // submit; legacy worker-pool ops don't register and get []). Without
  // this, the adapter never tells the model about its tool surface and
  // tool-needing chats degrade to "I'm in planning mode" responses.
  const input: TurnInput = {
    opId: op.id,
    turnIdx,
    messages,
    providerState: providerStateAcrossRuntimeBoundary(crossedRuntimeBoundary, prior?.providerState),
    tools: getToolsForOp(op.id),
  };
  if (pendingRedirect) input.pendingRedirect = pendingRedirect;
  // Compacted-view marker: turn-loop copies this onto the committed
  // provider_state so the NEXT turn's context sizing knows this turn's usage
  // describes the summary view, not the full replay (see types.ts).
  if (viewCompacted) input.viewCompacted = true;

  // Ephemeral situational-awareness digest — goal/constraint re-anchoring +
  // the durable open-plan, recomputed each turn and prepended to the last user
  // message (never persisted to op_messages, so it doesn't accumulate). Now on
  // the long autonomous lanes too (agent/background), which drift from the goal
  // over many turns exactly like interactive does — they were the lane most in
  // need of re-anchoring, not least. The `build` (app-build) lane stays out: it
  // has its own evidence/render gates and is the soak-sensitive one.
  if (op.lane === "interactive" || op.lane === "agent" || op.lane === "background") {
    const digest = buildSituationalAwareness(op, turnIdx);
    if (digest) input.messages = prependDigestToLastUser(input.messages, digest);
  }

  return input;
}

export function providerStateAcrossRuntimeBoundary(
  crossedRuntimeBoundary: boolean,
  prior: ProviderStateEnvelope | undefined,
): ProviderStateEnvelope | undefined {
  return crossedRuntimeBoundary ? undefined : prior;
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
