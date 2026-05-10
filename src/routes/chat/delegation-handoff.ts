import type { ServerResponse } from "node:http";

import { runAgent } from "../../agent.js";
import { createLogger } from "../../logger.js";
import type { ServerContext } from "../../server-context.js";
import { sseWrite } from "../../server-utils.js";
import { ThreatEngine } from "../../threat-engine.js";
import type { ServerEvent } from "../../types.js";
import type { Role } from "../../rbac.js";

const logger = createLogger("routes.chat.delegation");

interface PreparedAgentRequest {
  apiKey: string;
  model: string;
  provider: string;
  customBaseURL?: string;
  systemPrompt: string;
  cleanHistory: unknown[];
  images?: unknown[];
  temperature?: number;
}

interface SessionLike {
  messages: unknown[];
  updatedAt: number;
}

interface DelegationHandoffArgs {
  message: string;
  sessionId: string;
  prepared: PreparedAgentRequest;
  ctx: ServerContext;
  session: SessionLike;
  requestRole: Role;
  res: ServerResponse;
}

interface DelegationHandoffResult {
  /** Caller must set its `onEventInstalled` to `true` if this returns true. */
  onEventInstalled: boolean;
  /** Caller must set its `doneEmitted` to `true` if this returns true. */
  doneEmitted: boolean;
}

/**
 * Auto-delegated to worker pool: route the message into a fresh-context
 * worker subprocess and run a tiny no-tools chat turn so the agent
 * acknowledges the delegation in its own voice. Mutates `session.messages`
 * with the agent's ack reply, saves the session, emits the `done` SSE
 * event. Caller is expected to short-circuit (`return true`) afterwards.
 */
export async function runDelegationHandoff(args: DelegationHandoffArgs): Promise<DelegationHandoffResult> {
  const { message, sessionId, prepared, ctx, session, requestRole, res } = args;

  const { delegateMessageToWorker, linkDecisionToOpId } = await import("../../routing/index.js");

  const { opId } = await delegateMessageToWorker(message, sessionId, prepared.provider);
  // Link the decision entry to this opId so the UI's "Stay inline"
  // button can find + override it later. Saves the full message too
  // so we can re-submit on override.
  linkDecisionToOpId(opId, message);
  // Sidebar cards are now driven by the pool's op-queued / op-dispatched
  // events (Step 6) — no manual broadcast needed here. The session
  // bridge subscribes to those and forwards bg_op_queued (with queue
  // position) and bg_op_started (when a worker picks it up) to the
  // chat WS. Cleaner than the old "fire bg_op_started immediately
  // even if the op is queued" pattern, which lied about state.
  // Instead of streaming a hardcoded "🤖 routing notice" string, run a
  // tiny no-tools chat turn so the AGENT itself acknowledges the
  // delegation in its own voice. Same chat agent the user normally
  // talks to — just told via system note that the user's message
  // was already delegated to a worker, and asked to give a
  // 1-2 sentence conversational acknowledgement.
  const delegationContext =
    `\n\n[BACKGROUND DELEGATION — STRICT ACK MODE]\n\n` +
    `The user's message above has been handed to a background worker (op id: ${opId}, ${prepared.provider}). The worker has NOT done the work yet — it is just starting. The user can SEE the worker card in the sidebar with "WORKING" status; if you contradict that, your reply looks like a lie.\n\n` +
    `HARD RULES for THIS turn — do not break any of them:\n\n` +
    `1. PRESENT PROGRESSIVE ONLY. Use "I'm starting on X", "kicking off X", "spinning up X". NEVER past tense — no "built", "created", "finished", "saved", "published", "pinned", "live", "shipped", "done". Those words are forbidden.\n` +
    `2. NO SPECIFIC OUTPUTS. Do NOT name files, paths (workspace/apps/...), URLs, sidebar entries, feature lists, or specific UI elements that "now exist". The worker has produced NOTHING yet — anything specific you name is fabricated.\n` +
    `3. NO FAKE DETAIL. Do not describe what's "included" in the not-yet-built thing ("with branding", "with FAQ", "with form fields"). Only echo back what the user asked for, in their own words, as the thing being kicked off.\n` +
    `4. ONE OR TWO SENTENCES. Conversational. Then stop.\n` +
    `5. NO TOOLS. Do not call any tool. Tools are unavailable this turn anyway.\n` +
    `6. NO JARGON. Don't say "delegation", "worker pool", "op id" — just normal "kicking it off in the background".\n\n` +
    `Good shape: "Starting on the [thing user asked for] now — I'll let you know when it's ready."\n` +
    `Bad shape: "Built it: created at workspace/apps/X/index.html and pinned." (Lies — worker hasn't built anything yet.)`;
  const delegationSystemPrompt = prepared.systemPrompt + delegationContext;

  logger.info(`[router] Auto-delegated to worker pool: op=${opId} sess=${sessionId} provider=${prepared.provider} — routing notice now agent-voiced`);

  // Continue with the normal chat flow: set up onEvent + threat engine,
  // run runAgent with the delegation context + tools=[] (force text-only).
  const wsChat = ctx.chatWs.startChat(sessionId);
  const onEvent = (event: ServerEvent) => { sseWrite(res, event); wsChat.onEvent(event); };
  ctx.setActiveOnEvent(sessionId, onEvent);
  const threatEngineDel = new ThreatEngine(ctx.dataDir, sessionId);
  const turnStart = Date.now();
  const result = await runAgent(message, prepared.cleanHistory as Parameters<typeof runAgent>[1], {
    apiKey: prepared.apiKey, model: prepared.model,
    provider: prepared.provider as Parameters<typeof runAgent>[2]["provider"],
    baseURL: prepared.customBaseURL,
    systemPrompt: delegationSystemPrompt,
    tools: [],                                      // force text-only — no tool calls
    security: ctx.security, toolPolicy: ctx.toolPolicy,
    threatEngine: threatEngineDel, rbac: ctx.rbac, callerRole: requestRole, sessionId,
    images: prepared.images as Parameters<typeof runAgent>[2]["images"],
    maxIterations: 1,                               // 1-shot — agent says its piece, ends turn
    temperature: prepared.temperature,
    signal: wsChat.abort.signal,
    onEvent,
  });

  const { stripEphemeralMessages } = await import("../../agent-providers.js");
  const { COMPACTION_PREFIX } = await import("../../types.js");
  type MsgRecord = Record<string, unknown>;
  session.messages = stripEphemeralMessages(result.messages).filter((m) => {
    if (m.role === "system") {
      return typeof m.content === "string" && m.content.startsWith(COMPACTION_PREFIX);
    }
    if (m.role === "tool") return true;
    return m.content || (m as unknown as MsgRecord).tool_calls;
  });
  session.updatedAt = Date.now();
  ctx.saveSession(session as Parameters<typeof ctx.saveSession>[0]);

  const realUsage = result.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  onEvent({ type: "done", usage: realUsage });
  logger.info(`[timing] delegation-ack turn ${Date.now() - turnStart}ms (${prepared.provider}/${prepared.model}, ${realUsage.totalTokens} tokens)`);

  return { onEventInstalled: true, doneEmitted: true };
}
