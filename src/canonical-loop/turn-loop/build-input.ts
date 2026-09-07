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
import { classifyStepEffort } from "../step-effort.js";
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

  // Per-step effort hint: a mechanical continuation (trailing all-ok
  // file-mechanics tool_result batch, turn > 0) lets adapters down-shift
  // reasoning effort for this step. Absent = standard = today's behavior.
  // Classifier + kill switch (LAX_STEP_EFFORT=off) live in step-effort.ts.
  // MUST run BEFORE the digest append below: the classifier keys off the
  // TRAILING tool_result batch, and an ephemeral trailing user row hides it.
  // Order is asserted by build-input.test.ts ("classifies a mechanical
  // continuation BEFORE the digest append hides the batch"): appending first
  // makes `start === messages.length` in step-effort.ts and every mechanical
  // continuation silently classifies "standard".
  if (classifyStepEffort(input) === "mechanical") input.stepEffortHint = "mechanical";

  // Ephemeral situational-awareness digest — goal/constraint re-anchoring +
  // the durable open-plan, recomputed each turn and APPENDED as its own
  // trailing user message (never persisted to op_messages, so it doesn't
  // accumulate). Now on the long autonomous lanes too (agent/background),
  // which drift from the goal over many turns exactly like interactive does —
  // they were the lane most in need of re-anchoring, not least. The `build`
  // (app-build) lane stays out: it has its own evidence/render gates and is
  // the soak-sensitive one.
  //
  // Why a trailing message and not a rewrite of the last user row (the old
  // prependDigestToLastUser): the digest's bytes change EVERY turn, and the
  // last user row sits EARLY in the array on a continuation turn. Rewriting it
  // moved a mutation into the middle of the conversation prefix, so turn N's
  // message array was never a prefix of turn N+1's and the Anthropic
  // message-tier cache breakpoint could never hit — every turn re-wrote the
  // whole conversation to cache at 1.25x and read back nothing. Appending
  // keeps [0, len-1) byte-identical across turns; `ephemeralTailMessages`
  // tells the transport to put the breakpoint BELOW the volatile tail.
  let digestAppended = false;
  if (op.lane === "interactive" || op.lane === "agent" || op.lane === "background") {
    const digest = buildSituationalAwareness(op, turnIdx);
    if (digest) {
      // Run the append back through collapseAdjacentUserMessages. When the
      // history already ENDS on a user row (a fresh user turn, a nudge), a
      // bare append hands codex/gemini a run of user-only rows — the shape
      // this file's own comment (and providers/sanitize.ts) says makes Codex
      // return EMPTY responses, and the canonical view exists precisely so no
      // transport has to repair it. Collapsing reuses the rule already here
      // instead of teaching each transport a second one, and it costs the
      // cache nothing: the merged row is still the LAST row, so it is exactly
      // the one ephemeralTailMessages already declares volatile, and
      // everything above it stays byte-identical turn over turn.
      input.messages = collapseAdjacentUserMessages([
        ...input.messages,
        situationalMessage(op.id, turnIdx, digest),
      ]);
      digestAppended = true;
    }
  }
  // The volatile trailing rows the transport must place its cache breakpoint
  // BENEATH. Two things land there and both are regenerated per turn: the
  // digest above, and the pendingRedirect the adapters append OUTSIDE
  // `messages` (canonical-to-transport.ts / canonical-to-chat-param.ts). The
  // redirect is FOLDED into a trailing user row when there is one, so the
  // volatile tail is exactly one row in every combination:
  //   digest only            → the digest row
  //   redirect only          → the appended [REDIRECT] row (or the fold)
  //   digest + redirect      → one row: the digest with the redirect folded in
  // Counting the redirect as a second row would push the marker one row too
  // high (harmless but wasteful); omitting it entirely put the marker ON the
  // volatile digest on every redirect turn — the exact 1.25x-write-never-read
  // failure this field exists to prevent.
  if (digestAppended || pendingRedirect) input.ephemeralTailMessages = 1;

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
// nudge. Anthropic's Messages API tolerates these (consecutive same-role
// messages are merged into a single turn server-side), but codex-style
// transports expect strict user/assistant alternation — runs of user-only
// rows yield empty responses (see the coalesce step in providers/sanitize.ts)
// — so collapsing at the canonical view keeps every adapter's replay uniform
// instead of leaving each transport to repair it. op_messages on disk is
// untouched — this only shapes the per-turn model view. Image-bearing user
// rows are left standalone so their attachment semantics survive.
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

// The ephemeral situational-awareness row. A plain user message carrying only
// the digest, placed LAST so everything above it is byte-identical to the
// previous turn's array (the property the Anthropic message-tier prompt cache
// needs). The messageId is derived, not random, so two builds of the same turn
// are identical; it is never written to op_messages — buildTurnInput is a pure
// read and only adapter-finalized messages are committed (see checkpoint.ts).
function situationalMessage(opId: string, turnIdx: number, digest: string): CanonicalMessage {
  return { messageId: `sa-${opId}-${turnIdx}`, role: "user", content: { text: digest } };
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
