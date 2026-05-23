/**
 * Op tools — let the chat agent delegate work to the canonical-loop.
 *
 * The 6 tool definitions live in src/ops/tools/:
 *   op-submit-async.ts — op_submit_async — PRIMARY: fire-and-forget. Returns
 *                        opId immediately so the chat agent can keep
 *                        responding. The session bridge surfaces the result
 *                        back into the chat session when the worker finishes.
 *   op-wait.ts         — op_wait — Block on a specific opId until it
 *                        completes (or timeout). Use when the agent genuinely
 *                        needs the result before continuing the current turn.
 *   op-submit.ts       — op_submit — Sugar wrapper = op_submit_async +
 *                        immediate op_wait. Convenient for short ops; for
 *                        anything heavy, prefer op_submit_async so the user
 *                        isn't stuck waiting.
 *   op-status.ts       — op_status — Inspect any op (active or persisted).
 *                        With no opId, lists ops the current session has
 *                        submitted plus the scheduler summary.
 *   op-kill.ts         — op_kill — Cancel an op (cooperative; transitions
 *                        running → cancelling, aborts the adapter mid-stream).
 *   op-redirect.ts     — op_redirect — Inject an instruction into a running
 *                        op (latest-wins).
 *   shared.ts          — buildOpFromArgs, submit-params schema, session-level
 *                        dedup state shared across the submit + status tools.
 *
 * Why async-first: a blocking op_submit holds the chat agent's turn open
 * until the op finishes. The async variant is the actual UX unblock that
 * makes the delegation feel like a parallel system instead of a sync RPC.
 */

import type { ToolDefinition } from "../types.js";
import { opSubmitAsyncTool } from "./tools/op-submit-async.js";
import { opWaitTool } from "./tools/op-wait.js";
import { opSubmitTool } from "./tools/op-submit.js";
import { opStatusTool } from "./tools/op-status.js";
import { opKillTool } from "./tools/op-kill.js";
import { opRedirectTool } from "./tools/op-redirect.js";

export { opSubmitAsyncTool } from "./tools/op-submit-async.js";
export { opWaitTool } from "./tools/op-wait.js";
export { opSubmitTool } from "./tools/op-submit.js";
export { opStatusTool } from "./tools/op-status.js";
export { opKillTool } from "./tools/op-kill.js";
export { opRedirectTool } from "./tools/op-redirect.js";

export const opTools: ToolDefinition[] = [
  opSubmitAsyncTool,  // listed first so registry order matches "preferred" intent
  opWaitTool,
  opSubmitTool,
  opStatusTool,
  opKillTool,
  opRedirectTool,
];
