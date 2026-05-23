/**
 * Phase dispatcher for the canonical-loop middleware stack.
 *
 * Builds a CanonicalLoopContext and walks the registered middlewares for
 * one phase. Short-circuits on the first non-"continue" result (same
 * semantics as src/agent-loop/run.ts:runPhase) so a nudge / abort from an
 * earlier middleware preempts later ones for THIS phase.
 *
 * Returns the firing middleware's name in `firedBy` so the caller can
 * surface a friendly stop reason in chat.
 */
import type { Op } from "../../ops/types.js";
import type { ToolCall, ToolDescriptor } from "../contract-types.js";
import type { ServerEvent } from "../../types.js";
import type {
  CanonicalLoopContext,
  CanonicalMiddleware,
  CanonicalMiddlewareResult,
  CanonicalToolResultView,
} from "./types.js";
import { getDefaultMiddlewareStack } from "./registry.js";
import { readOpMessages, readOpTurns } from "../store.js";
import { isCommittingTool } from "../../committing-tool-check.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type PhaseName = "beforeTurn" | "afterModelCall" | "afterToolExecution";

/** Result of running one phase against the middleware stack. Carries the
 *  short-circuited verdict plus the name of the middleware that produced it.
 *  Discriminated union so consumers can switch on `kind` exhaustively. */
export type FiredMiddlewareResult = CanonicalMiddlewareResult & { firedBy?: string };

export interface BuildContextArgs {
  op: Op;
  turnIdx: number;
  /** Tool descriptors advertised to the adapter. */
  tools?: ToolDescriptor[];
  /** Tool calls this turn requested. May start empty in beforeTurn. */
  toolCalls?: ToolCall[];
  /** Tool results this turn produced. May start empty before afterToolExecution. */
  toolResults?: CanonicalToolResultView[];
  /** Assistant text emitted this turn. May start empty in beforeTurn. */
  assistantContent?: string;
  /** Optional event forwarder (chat path); undefined for headless ops. */
  onEvent?: (event: ServerEvent) => void;
  /** Per-op evidence history maintained by the caller across turns. */
  evidenceHistory: number[];
}

/**
 * Construct a CanonicalLoopContext for one phase invocation. Cheap to
 * rebuild — derived state (toolsCalledThisOp, committingToolsThisOp) is
 * read from op_messages each call.
 */
export function buildCanonicalLoopContext(args: BuildContextArgs): CanonicalLoopContext {
  const { op } = args;
  const opAny = op as unknown as {
    contextPack?: { preferredProvider?: string; budget?: unknown };
    model?: string;
  };
  const contextPack = (op as { contextPack?: { preferredProvider?: string } }).contextPack;
  const provider = contextPack?.preferredProvider
    ?? (opAny as { provider?: string }).provider
    ?? "unknown";
  // Resolve the op's model in order of authority:
  //   1. op.model explicitly set on the op (worker contexts, etc.)
  //   2. op.canonical.model from the resolved request
  //   3. user's configured model in ~/.lax/settings.json (same model the
  //      chat is actually running — not a substitute, just looking it up
  //      from a different place when it didn't propagate onto the op)
  // If NONE of those resolve, throw — that's a real upstream plumbing bug
  // and silently substituting a hardcoded default would mask it. Same
  // fail-closed posture we use for the AriKernel wire elsewhere.
  let model = (opAny.model as string | undefined)
    ?? ((op as { canonical?: { model?: string } }).canonical?.model);
  if (!model) {
    try {
      const settingsPath = join(homedir(), ".lax", "settings.json");
      if (existsSync(settingsPath)) {
        const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as { model?: string };
        if (typeof raw.model === "string" && raw.model.length > 0) model = raw.model;
      }
    } catch { /* fall through to throw */ }
  }
  if (!model) {
    throw new Error(
      `[canonical-loop] No model resolvable for op ${op.id}. ` +
      `Neither op.model nor op.canonical.model is set, and ~/.lax/settings.json has no .model field. ` +
      `This is an upstream plumbing bug — fix the op-creation site or settings.json. ` +
      `Refusing to silently default; that masks the real failure.`
    );
  }

  // Per-op success ledger. A tool name lands here only when a prior turn's
  // toolCallSummary recorded resultStatus === "ok" for it. Attempts that
  // errored or were cancelled DO NOT count as proof of work — otherwise a
  // failed agent_spawn (or any other spawn-class tool) lets the model claim
  // "background worker is on it" and clear the hallucination guard. The
  // structured per-turn summary in op_turns is the authoritative source;
  // op_messages doesn't carry status alongside the tool name.
  const toolsCalledThisOp = new Set<string>();
  const committingToolsThisOp = new Set<string>();
  for (const turn of readOpTurns(op.id)) {
    for (const s of turn.toolCallSummary ?? []) {
      if (s.resultStatus !== "ok") continue;
      toolsCalledThisOp.add(s.tool);
      if (isCommittingTool(s.tool)) committingToolsThisOp.add(s.tool);
    }
  }

  let userMessage = "";
  for (const r of readOpMessages(op.id)) {
    if (r.role !== "user") continue;
    const t = (r.content as { text?: string })?.text;
    if (typeof t === "string" && t) { userMessage = t; break; }
  }
  if (!userMessage) userMessage = op.task ?? "";

  const tools = args.tools ?? [];
  const toolNames = new Set(tools.map(t => t.name));

  return {
    op,
    turnIdx: args.turnIdx,
    userMessage,
    provider,
    model,
    tools,
    toolNames,
    assistantContent: args.assistantContent ?? "",
    toolCalls: args.toolCalls ?? [],
    toolResults: args.toolResults ?? [],
    toolsCalledThisOp,
    committingToolsThisOp,
    evidenceHistory: args.evidenceHistory,
    onEvent: args.onEvent,
  };
}

export async function runMiddlewarePhase(
  ctx: CanonicalLoopContext,
  phase: PhaseName,
  middlewares: CanonicalMiddleware[] = getDefaultMiddlewareStack(),
): Promise<FiredMiddlewareResult> {
  for (const mw of middlewares) {
    if (mw.when && !mw.when(ctx)) continue;
    const hook = mw[phase];
    if (!hook) continue;
    const res = await hook(ctx);
    if (res.kind !== "continue") return { ...res, firedBy: mw.name };
  }
  return { kind: "continue" };
}

/**
 * Active middleware stack — opt-in.
 *
 * Default: empty `[]`. The canonical-loop turn driver runs zero middlewares
 * unless a caller has explicitly installed a stack. This keeps P4.C2
 * "additive only": shipping the implementation without changing the
 * observable behavior of canonical-loop until a caller (production chat-
 * runner, P4.C3-C5 migrators) flips it on.
 *
 * Callers that want the full legacy safety parity call
 * `enableDefaultMiddlewareStack()` once at boot. Tests that need a
 * specific stack pass it to `setMiddlewareStack`.
 */
let activeStack: CanonicalMiddleware[] = [];

export function setMiddlewareStack(stack: CanonicalMiddleware[]): void {
  activeStack = stack;
}

/** Install the default canonical safety stack (mirrors agent-loop's
 *  per-provider universal middlewares + provider-specific extras). */
export function enableDefaultMiddlewareStack(): void {
  activeStack = getDefaultMiddlewareStack();
}

export function getActiveMiddlewareStack(): CanonicalMiddleware[] {
  return activeStack;
}

/** Test/runtime hook — drop any installed stack. */
export function _resetMiddlewareStack(): void {
  activeStack = [];
}
