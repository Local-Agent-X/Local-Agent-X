/**
 * Bridge: canonical-loop ToolDispatcher → chat's executeToolCalls.
 *
 * Why this exists: the canonical-loop has its own `ToolCall`/`ToolDispatchResult`
 * shape. The chat tool runtime (`tool-executor.ts`) takes a different shape
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
import type { ToolDispatcher, ToolDispatchResult } from "./tool-dispatch.js";
import type { ToolCall } from "./contract-types.js";
import type { ToolDefinition, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { executeToolCalls } from "../tool-executor.js";
import { registerToolsForOp } from "./runtime.js";
import { unifiedRegistry } from "../tools/registry.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.chat-tool-dispatcher");

export interface ChatToolDispatcherOptions {
  tools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId: string;
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
}

/**
 * Build a canonical-loop `ToolDispatcher` that delegates to the chat tool
 * runtime. The closure captures session-scoped context — register one per
 * op via `registerToolDispatcherForOp`.
 */
export function makeChatToolDispatcher(opts: ChatToolDispatcherOptions): ToolDispatcher {
  const toolMap = new Map(opts.tools.map(t => [t.name, t]));

  return {
    async dispatch(call: ToolCall): Promise<ToolDispatchResult> {
      const t0 = Date.now();
      const argsJson = (() => {
        try { return JSON.stringify(call.args ?? {}); }
        catch { return "{}"; }
      })();

      try {
        const messages = await executeToolCalls(
          [{ id: call.toolCallId, name: call.tool, arguments: argsJson }],
          toolMap,
          opts.security,
          opts.toolPolicy,
          opts.threatEngine,
          opts.rbac,
          opts.callerRole,
          opts.sessionId,
          opts.onEvent,
          opts.signal,
          /* priorMessages */ undefined,
          opts.runId,
        );

        // executeToolCalls returns 1+ ChatCompletionMessageParam. The
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
            durationMs: Date.now() - t0,
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

        // The canonical ToolDispatchResult.status is a narrow 3-value enum
        // (ok | error | cancelled). Recover the underlying envelope status
        // from the rendered header so failures, blocks, and timeouts don't
        // get reported as "ok" in the canonical summary. `running` maps to
        // "ok" because the START succeeded — the work continues async.
        const { parseStatusHeader } = await import("../tools/result-helpers.js");
        const envStatus = parseStatusHeader(content);
        const canonicalStatus: ToolDispatchResult["status"] =
          envStatus === "ok" || envStatus === "running" ? "ok" : "error";

        // Video/large media rides a file path on the tool message (set by
        // shapeMsg). Carry it onto the result envelope so bridge handlers can
        // forward the file — same channel as harvested images, path not bytes.
        const media = (toolMsg as { _media?: { kind: string; path: string; mime: string } })._media;
        const result: unknown = harvestedImages.length > 0 || media
          ? { text: content, ...(harvestedImages.length > 0 ? { images: harvestedImages } : {}), ...(media ? { media } : {}) }
          : content;

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
            augmentFromToolSearch(content, opts.opId, toolMap);
          } catch (e) {
            logger.warn(`[augment] tool_search augmentation failed: ${(e as Error).message}`);
          }
        }

        return {
          toolCallId: call.toolCallId,
          status: canonicalStatus,
          result,
          durationMs: Date.now() - t0,
        };
      } catch (e) {
        return {
          toolCallId: call.toolCallId,
          status: "error",
          result: { error: (e as Error).message },
          durationMs: Date.now() - t0,
        };
      }
    },
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
): void {
  // tool_search returns content like:
  //   "No tools matched the query."   (skip path)
  //   "[ { name, description, parameters }, ... ]"
  if (!content.trim().startsWith("[")) return;

  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return; }
  if (!Array.isArray(parsed)) return;

  const added: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || !name) continue;
    if (toolMap.has(name)) continue;
    const tool = unifiedRegistry.get(name);
    if (!tool) continue;
    toolMap.set(name, tool);
    added.push(name);
  }

  if (added.length === 0) return;

  const augmented = Array.from(toolMap.values()).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
  registerToolsForOp(opId, augmented);
  logger.info(`[augment] +${added.length} tool(s) for op=${opId.slice(0, 12)}: ${added.join(", ")}`);
}
