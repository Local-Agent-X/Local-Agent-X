/**
 * Bridge: canonical-loop ToolDispatcher → chat's executeToolCalls.
 *
 * Why this exists: the canonical-loop has its own `ToolCall`/`ToolDispatchResult`
 * shape. The chat tool runtime (`tool-execution/`) takes a different shape
 * with security context, RBAC, threat engine, session callbacks, etc. This
 * module is the per-op closure that wires one to the other so a chat op
 * running through canonical can use the SAME tool implementations the
 * legacy chat path uses — no duplication, no second tool registry.
 *
 * Per-op scope: `registerToolDispatcherForOp(opId, makeChatToolDispatcher(...))`
 * captures the chat session's security/RBAC/event callback. When the op
 * terminates, the chat runner calls `unregisterToolDispatcherForOp(opId)`
 * so the closure GC'd.
 */
import { envelopeStatusToDispatchStatus, type ToolDispatcher, type ToolDispatchResult } from "./tool-dispatch.js";
import { parseStatusHeader } from "../tools/result-helpers.js";
import type { ToolCall } from "./contract-types.js";
import type { ToolDefinition, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { executeToolCalls } from "../tool-execution/index.js";
import { readOpMessages } from "./store.js";
import { opMessageRowToChatParam } from "./chat-runner/message-convert.js";
import { registerToolsForOp } from "./runtime.js";
import { unifiedRegistry } from "../tools/registry.js";
import { enqueueBridgeMedia } from "../bridge-media-queue.js";
import { createLogger } from "../logger.js";
import type { CallContext } from "../tool-execution/context.js";

const logger = createLogger("canonical-loop.chat-tool-dispatcher");

export interface ChatToolDispatcherOptions {
  tools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId: string;
  /** Trusted dispatch origin. Omitted callers fail closed as unattended API. */
  callContext?: CallContext;
  /** Op id for the current canonical chat op. When provided, a successful
   *  tool_search call side-effect-registers the discovered tools onto the op's
   *  tool list — so the next iteration's request schema includes them and the
   *  model can actually emit a tool_use for what it just found. Without this,
   *  tool_search returns schemas as text only and deferred tools stay
   *  uncallable in-session. */
  opId?: string;
  /** Agent run id when this dispatcher serves a spawned-agent op. Threaded
   *  into `ToolCallContext.runId` so the trace emit-phase can write a per-run
   *  activity log. Absent on chat-turn dispatchers. */
  runId?: string;
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
  /** Durable runtime owner callbacks. They complete before process-local state widens. */
  onToolsAugmented?: (tools: ToolDefinition[]) => void;
  onRuntimeStateChange?: () => void;
}

/**
 * Build a canonical-loop `ToolDispatcher` that delegates to the chat tool
 * runtime. The closure captures session-scoped context — register one per
 * op via `registerToolDispatcherForOp`.
 */
export function makeChatToolDispatcher(opts: ChatToolDispatcherOptions): ToolDispatcher {
  const toolMap = new Map(opts.tools.map(t => [t.name, t]));

  const toWireCall = (call: ToolCall): { id: string; name: string; arguments: string } => ({
    id: call.toolCallId,
    name: call.tool,
    arguments: (() => {
      try { return JSON.stringify(call.args ?? {}); }
      catch { return "{}"; }
    })(),
  });

  // Prior-turn history for the resolve phase's intent + dedup guards.
  // The dispatcher is constructed once per op, but self_edit's intent
  // gate ("did the user actually ask for this edit") and the
  // session-repeat dedup need the conversation as of THIS call — so read
  // the op's persisted messages fresh on each dispatch. Sanctioned: we
  // are inside canonical-loop and project rows through the canonical
  // opMessageRowToChatParam adapter (see the SEAL in store.ts). Passing
  // undefined here — the prior behavior — silently failed both guards
  // open on every canonical-path tool call. opId is absent only on
  // non-op callers, which keep the old (guardless) behavior.
  const readPriorMessages = (): ChatCompletionMessageParam[] | undefined => opts.opId
    ? readOpMessages(opts.opId)
        .map(opMessageRowToChatParam)
        .filter((m): m is ChatCompletionMessageParam => m !== null)
    : undefined;

  const runExecuteToolCalls = (
    wireCalls: Array<{ id: string; name: string; arguments: string }>,
  ): Promise<ChatCompletionMessageParam[]> => executeToolCalls(
    wireCalls,
    toolMap,
    opts.security,
    opts.toolPolicy,
    opts.threatEngine,
    opts.rbac,
    opts.callerRole,
    opts.sessionId,
    opts.onEvent,
    opts.signal,
    readPriorMessages(),
    opts.runId,
    opts.opId,
    opts.callContext ?? "api",
  );

  const errorResult = (call: ToolCall, e: unknown, durationMs: number): ToolDispatchResult => ({
    toolCallId: call.toolCallId,
    status: "error",
    result: { error: (e as Error).message },
    durationMs,
  });

  return {
    async dispatch(call: ToolCall): Promise<ToolDispatchResult> {
      const t0 = Date.now();
      try {
        const messages = await runExecuteToolCalls([toWireCall(call)]);
        const result = shapeCallResult(call, messages, Date.now() - t0, opts, toolMap);
        opts.onRuntimeStateChange?.();
        return result;
      } catch (e) {
        return errorResult(call, e, Date.now() - t0);
      }
    },

    // Turn-level batch dispatch: pass the WHOLE tool_call_requested list into
    // ONE executeToolCalls invocation so its existing batcher (adjacent
    // parallel-safe grouping + R4-09 gate-atomicity splits) decides what runs
    // concurrent vs serial. Correlation back to per-call results: every
    // tool-role message carries the call's tool_call_id (shapeMsg in
    // audit-tool-call.ts:157, and every halt path — context.ts:126/131,
    // resolve-tool.ts:200); the vision user-role messages carry NO id and are
    // pushed immediately AFTER their tool message inside the same call's
    // ctx.msgs, and executeToolCalls keeps each call's messages contiguous
    // (parallel.flat() preserves batch positions) — so adjacency attributes
    // them. durationMs: per-call time is not individually measurable inside
    // one executeToolCalls run, so every result carries the batch wall-clock;
    // the consumer is soak telemetry and the approximation is acceptable.
    async dispatchBatch(calls: ToolCall[]): Promise<ToolDispatchResult[]> {
      const t0 = Date.now();
      try {
        const messages = await runExecuteToolCalls(calls.map(toWireCall));
        const groups = groupMessagesByCall(messages);
        const durationMs = Date.now() - t0;
        const results = calls.map(call =>
          shapeCallResult(call, groups.get(call.toolCallId) ?? [], durationMs, opts, toolMap));
        opts.onRuntimeStateChange?.();
        return results;
      } catch (e) {
        const durationMs = Date.now() - t0;
        return calls.map(call => errorResult(call, e, durationMs));
      }
    },
  };
}

/**
 * Partition executeToolCalls' flat message list into per-call groups. A
 * tool-role message opens its call's group (keyed by its tool_call_id);
 * id-less follow-on messages (the vision user-role messages) attach to the
 * most recent tool message — see the adjacency facts on dispatchBatch above.
 */
function groupMessagesByCall(
  messages: ChatCompletionMessageParam[],
): Map<string, ChatCompletionMessageParam[]> {
  const groups = new Map<string, ChatCompletionMessageParam[]>();
  let current: ChatCompletionMessageParam[] | undefined;
  for (const m of messages) {
    const id = m.role === "tool" ? (m as { tool_call_id?: string }).tool_call_id : undefined;
    if (id) {
      current = groups.get(id);
      if (!current) { current = []; groups.set(id, current); }
    }
    current?.push(m);
  }
  return groups;
}

/**
 * Per-call result shaping shared by `dispatch` and `dispatchBatch`:
 * envelope-status recovery, image harvesting, bridge-media enqueue, and the
 * tool_search augmentation side-effect. `messages` is THIS call's slice of
 * executeToolCalls output.
 */
function shapeCallResult(
  call: ToolCall,
  messages: ChatCompletionMessageParam[],
  durationMs: number,
  opts: ChatToolDispatcherOptions,
  toolMap: Map<string, ToolDefinition>,
): ToolDispatchResult {
  // executeToolCalls returns 1+ ChatCompletionMessageParam per call. The
  // first tool-role message is the canonical "result" payload.
  // Vision-emitting tools (browser screenshot, image_read, etc.)
  // ALSO push a user-role message with multi-part image_url
  // content — that's how the legacy loop fed images back to the
  // model. Extract those image bytes and ride them on the
  // dispatch-result envelope so:
  //   1. The next-turn adapter can re-emit them as a user
  //      message (so the model SEES the screenshot it took).
  //   2. Bridge handlers can scan op_messages tool_result rows
  //      and forward the bytes to Telegram/WhatsApp.
  // Without this the dispatcher silently drops tool-emitted
  // images and vision-using tools regress on canonical.
  const toolMsg = messages.find(m => m.role === "tool") as
    | (ChatCompletionMessageParam & { role: "tool"; content: string | unknown })
    | undefined;

  if (!toolMsg) {
    return {
      toolCallId: call.toolCallId,
      status: "error",
      result: { error: `tool '${call.tool}' produced no result message` },
      durationMs,
    };
  }

  const content = typeof toolMsg.content === "string"
    ? toolMsg.content
    : JSON.stringify(toolMsg.content);

  // Harvest image_url parts from any user-role messages the
  // executor produced for this tool call.
  const harvestedImages: Array<{ mime: string; b64: string }> = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ type: string; image_url?: { url: string } }>) {
      if (part.type !== "image_url" || !part.image_url?.url) continue;
      const match = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url);
      if (!match) continue;
      harvestedImages.push({ mime: match[1], b64: match[2] });
    }
  }

  // Recover the underlying envelope status from the rendered header and
  // carry the FLAVOR through the dispatch boundary — a policy block, a
  // user decline, and a timeout are different signals to the ledger /
  // telemetry / checkpoints. The only collapse is `running` → "ok":
  // the START succeeded, the work continues async.
  const envStatus = parseStatusHeader(content);
  const canonicalStatus: ToolDispatchResult["status"] =
    envelopeStatusToDispatchStatus(envStatus);

  // Video/large media rides a file path on the tool message (set by
  // shapeMsg). Carry it onto the result envelope so bridge handlers can
  // forward the file — same channel as harvested images, path not bytes.
  const media = (toolMsg as { _media?: { kind: string; path: string; mime: string } })._media;
  const result: unknown = harvestedImages.length > 0 || media
    ? { text: content, ...(harvestedImages.length > 0 ? { images: harvestedImages } : {}), ...(media ? { media } : {}) }
    : content;

  // Hand outbound media to the bridge here, at dispatch — bridge turns
  // don't persist fresh tool results with their media envelope to
  // op_messages, so the bridge can't re-read it. Keyed by op id; the
  // bridge drains it after the turn. No-op (just bounded memory) for web
  // chat, which renders media inline from this same result envelope.
  if (opts.opId && (harvestedImages.length > 0 || media)) {
    enqueueBridgeMedia(opts.opId, {
      imageB64: harvestedImages.map(i => i.b64),
      imagePath: media?.kind === "image" ? media.path : undefined,
      videoPath: media?.kind === "video" ? media.path : undefined,
    });
  }

  // Deferred-tool augmentation. tool_search returns schemas as text;
  // without re-registering them on the op the provider's next request
  // still lacks those tools and the model can't emit a tool_use for
  // them. Side-effect path:
  //   1. Parse the matched names out of the tool_search JSON output.
  //   2. Look each up in the unified registry (source of truth for
  //      every tool the server knows about).
  //   3. Add to the local toolMap so the dispatcher can execute them.
  //   4. Re-register the op's tool list (union) so the model's next
  //      request schema includes them.
  if (call.tool === "tool_search" && opts.opId && canonicalStatus === "ok") {
    try {
      augmentFromToolSearch(content, opts.opId, toolMap, opts.onToolsAugmented);
    } catch (e) {
      if (opts.onToolsAugmented) throw e;
      logger.warn(`[augment] tool_search augmentation failed: ${(e as Error).message}`);
    }
  }

  return {
    toolCallId: call.toolCallId,
    status: canonicalStatus,
    result,
    durationMs,
  };
}

/**
 * Parse tool_search's JSON output, look discovered tools up in the unified
 * registry, and union them into the op's executable + schema-visible tool
 * sets. Mutates `toolMap` in place and re-registers the op's tool list.
 *
 * Idempotent — tools already present in toolMap are skipped, so repeated
 * tool_search calls don't blow up the schema with duplicates.
 *
 * Exported for unit testing — production callers go through the dispatcher
 * closure above.
 */
export function augmentFromToolSearch(
  content: string,
  opId: string,
  toolMap: Map<string, ToolDefinition>,
  beforeRegister?: (tools: ToolDefinition[]) => void,
): void {
  // tool_search returns content like:
  //   "No tools matched the query."   (skip path)
  //   "[ { name, description, parameters }, ... ]"
  if (!content.trim().startsWith("[")) return;

  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return; }
  if (!Array.isArray(parsed)) return;

  const discovered: ToolDefinition[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || !name) continue;
    if (toolMap.has(name)) continue;
    const tool = unifiedRegistry.get(name);
    if (!tool) continue;
    discovered.push(tool);
  }

  if (discovered.length === 0) return;

  const augmentedTools = [...toolMap.values(), ...discovered];
  beforeRegister?.(augmentedTools);
  for (const tool of discovered) toolMap.set(tool.name, tool);
  const augmented = augmentedTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
  registerToolsForOp(opId, augmented);
  logger.info(`[augment] +${discovered.length} tool(s) for op=${opId.slice(0, 12)}: ${discovered.map(tool => tool.name).join(", ")}`);
}
