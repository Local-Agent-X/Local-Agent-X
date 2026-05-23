/**
 * op_submit — sugar wrapper for op_submit_async + immediate op_wait. Convenient
 * for short ops where blocking the user is acceptable; prefer op_submit_async
 * for anything heavier.
 */

import type { ToolDefinition } from "../../types.js";
import {
  awaitCanonicalOp,
  canonicalLoopEntry,
  registerAdapterForOp,
} from "../../canonical-loop/index.js";
import { trackOpForSession } from "../session-bridge.js";
import {
  buildOpFromArgs,
  readSettingsProvider,
  submitParameters,
} from "./shared.js";

export const opSubmitTool: ToolDefinition = {
  name: "op_submit",
  description:
    "Convenience: submit an op AND wait for the result, in one call. Equivalent to op_submit_async + op_wait. ONLY use this for short ops (<10s) where blocking the user is acceptable. For anything heavier — builds, refactors, multi-file research — call op_submit_async instead so you can respond to the user immediately and surface the result via the auto-notification when it's ready. ALWAYS pass `lane` explicitly: `lane:'interactive'` for pure reasoning / Q&A / summarization / research synthesis / status checks / planning / reviewing / explaining / non-mutating analysis, `lane:'build'` for code edits / app builds / file writes / refactors / shell or test work / OAuth + account / integration setup, `lane:'background'` for scheduled or low-priority recurring jobs. CONTEXT-RELAY RULE: workers do NOT see the chat thread; copy any prior conversation context the worker needs into `task` / `scope_hint` / `context_files`. OAUTH / ACCOUNT-CONNECTION tasks: the task string must include (1) target service, (2) account/handle/business, (3) intended outcome, (4) whether user-side auth is expected. If any of those is unclear, ASK before delegating. If the task requires `/mcp`, OAuth approval, or 2FA, surface that to the user first instead of spawning a worker that will bail with WORK_NEEDS_INPUT. Keep OAuth/account-connection work on lane='build'.",
  parameters: submitParameters,
  async execute(args) {
    const task = String(args.task || "").trim();
    if (!task) return { content: "op_submit requires a 'task' description.", isError: true };

    const sessionId = String(args._sessionId || "");
    const op = await buildOpFromArgs(args);
    if (sessionId) trackOpForSession(op.id, sessionId, task);

    const opProvider = op.contextPack?.routing?.preferredProvider;
    const effectiveProvider = opProvider ?? (await readSettingsProvider());
    if (effectiveProvider === "codex") {
      const { createCodexAdapter } = await import("../../canonical-loop/index.js");
      registerAdapterForOp(op.id, () => createCodexAdapter({ sessionId: sessionId || undefined }));
    }
    const startMs = Date.now();
    canonicalLoopEntry(op, sessionId ? { sessionId } : {});
    const result = await awaitCanonicalOp(op.id, 30 * 60 * 1000);
    const wallMs = Date.now() - startMs;

    if (!result) {
      return {
        content: `op ${op.id} did not complete within 30 min. Call op_status(op_id="${op.id}") to check.`,
        isError: true,
      };
    }

    const summary =
      `op ${op.id} ${result.status} in ${Math.round(wallMs / 1000)}s` +
      (result.error ? `\n  error: ${result.error.message}` : "") +
      (result.filesChanged.length > 0 ? `\n  files: ${result.filesChanged.slice(0, 5).join(", ")}${result.filesChanged.length > 5 ? "..." : ""}` : "") +
      `\n\n${result.finalSummary}`;

    return { content: summary, isError: result.status !== "completed" };
  },
};
