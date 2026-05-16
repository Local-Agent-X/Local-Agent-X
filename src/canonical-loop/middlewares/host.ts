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
import { readOpMessages } from "../store.js";
import { isCommittingTool } from "../../committing-tool-check.js";

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
  const model = (opAny.model as string | undefined)
    ?? ((op as { canonical?: { model?: string } }).canonical?.model)
    ?? "";

  const toolsCalledThisOp = new Set<string>();
  const committingToolsThisOp = new Set<string>();
  const rows = readOpMessages(op.id);
  let userMessage = "";
  for (const r of rows) {
    if (r.role === "user" && !userMessage) {
      const t = (r.content as { text?: string })?.text;
      if (typeof t === "string") userMessage = t;
    }
    if (r.role !== "assistant") continue;
    const tc = (r.content as { toolCalls?: Array<{ name: string }> })?.toolCalls;
    if (!Array.isArray(tc)) continue;
    for (const c of tc) {
      toolsCalledThisOp.add(c.name);
      if (isCommittingTool(c.name)) committingToolsThisOp.add(c.name);
    }
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
