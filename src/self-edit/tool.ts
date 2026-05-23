/**
 * self_edit — delegates source-code repair to Claude Code.
 *
 * Purpose: when the in-Local-Agent-X agent hits a bug (tool call "succeeded"
 * but outcome is wrong, UI didn't update, endpoint returns wrong shape,
 * etc.), it can call self_edit("description of the bug or change") to have
 * Claude Code read the codebase, diagnose, patch, and rebuild.
 *
 * The main agent stays in charge of high-level reasoning ("the theme
 * didn't flip visually — something's wrong") and offloads the actual
 * code surgery to a model that's specifically trained for it.
 *
 * Default flow: sandboxed.
 *   - claude -p runs inside an isolated git worktree
 *   - after it returns, three gates run: build / server-bind / agent-smoke
 *   - only if all three pass do the changes merge to main
 *   - if any fail, the worktree branch is preserved and main is untouched
 *   - this means a self_edit that breaks the agent CANNOT brick the agent
 *
 * Bypass flow: when args._cwd is set (autopilot route) OR args._unsafe is
 * true (emergency rescues), claude -p runs directly in the supplied cwd
 * without sandbox gates. _unsafe is server-injected only — not in the
 * public schema — so the model can't ask for it.
 */

import type { ToolDefinition } from "../types.js";
import { LAX_REPO_ROOT } from "./agents-rules.js";
import { checkScopeEvidence } from "./scope-gate.js";
import { checkSelfEditIntent } from "./intent-gate.js";
import {
  acquireSelfEditLock,
  buildLiveCallBlockedResponse,
  getActiveSelfEdit,
  releaseSelfEditLock,
} from "./session-lock.js";
import { buildSelfEditPrompt } from "./prompt.js";
import { runSelfEditBypass } from "./bypass-runner.js";

export const selfEditTool: ToolDefinition = {
  name: "self_edit",
  description:
    "Self-repair AND self-extension: modify the Local Agent X source code (.ts files in src/, " +
    "route handlers, tool implementations, server logic) to fix a bug OR add a capability that " +
    "doesn't exist yet. Delegates source-code surgery to a code-specialized subprocess with " +
    "read/edit/bash access to the whole repo (including protected files where regular `edit` is " +
    "blocked). Returns a diagnosis + list of changed files. The user must restart the server " +
    "after to pick up changes — tell them.\n\n" +
    "USE self_edit FOR:\n" +
    "- Bug fixes in source: a tool returned 200 but the UI didn't update, an endpoint returns " +
    "wrong shape, a route is missing, a feature works on one provider but not another, user " +
    "reports 'that didn't work' after what looked like success.\n" +
    "- Missing capabilities: you NEED a tool that doesn't exist to complete the user's task. " +
    "Examples: user sends voice message and there's no transcribe_audio tool → self_edit({task: " +
    "'Add transcribe_audio tool using local whisper, install whisper-node via npm'}). User wants " +
    "to schedule a recurring email and there's no recurring_email tool → self_edit to add it. " +
    "If after this self_edit the agent will have a new tool that matches the intent, that's the " +
    "right call.\n\n" +
    "BEFORE calling self_edit, CHECK THE EXISTING TOOL LIST. If a tool already covers the intent, " +
    "use that tool — don't add a duplicate. Common misroutes that should NOT be self_edit:\n" +
    "- 'Launch an installer' → install_software has strategy='launch' (don't add launch_installer)\n" +
    "- 'Install software' → install_software handles it (don't add install_X)\n" +
    "- 'Run a shell command' → bash exists for this (don't add run_command)\n" +
    "- 'Edit a workspace/ file' → edit covers it (self_edit is for SOURCE only)\n" +
    "- 'Change a setting' → http_request POST to /api/settings (don't add settings_set)\n" +
    "- 'Hot-reload config' → edit a file in config/ directly (don't go through self_edit)\n\n" +
    "When wiring up code that ALREADY exists at a known path (e.g. a prototype in workspace/, " +
    "integrations/, or a sibling module), name that path in your task — self_edit reads the " +
    "codebase fresh per call and will REWRITE from scratch otherwise, duplicating work.\n\n" +
    "ONE self_edit per chat session at a time — if one is already running, wait for it to finish. " +
    "Parallel self_edits create overlapping worktree branches you'll have to reconcile by hand.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Describe the bug or requested change in plain English. Include " +
          "what you tried, what happened, and what SHOULD have happened. The more " +
          "observable detail (symptom, HTTP call, error message) the better. " +
          "If a prototype or reference implementation already exists somewhere, name " +
          "the path explicitly so self_edit moves/adapts it instead of rewriting.",
      },
      scope_hint: {
        type: "string",
        description: "Optional file or directory hint if you already know roughly " +
          "where the bug is (e.g. 'src/routes/settings.ts' or 'public/js/chat.js').",
      },
    },
    required: ["task"],
  },
  async execute(args, signal) {
    const task = String(args.task || "").trim();
    if (!task) return { content: "self_edit requires a 'task' description.", isError: true };

    // Layer 2: scope-evidence gate — reject too-vague task descriptions.
    const scopeBlock = checkScopeEvidence(task);
    if (scopeBlock) return { content: scopeBlock.message, isError: true };

    // Layer 1: intent-match gate.
    //
    // Defends against the "agent grabs self_edit under intent-mapping
    // uncertainty and submits a task on a different topic" failure mode
    // (live failure 2026-05-07: user said "launch the ollama installer" →
    // agent self_edit'd to modify cron jobs).
    //
    // Uses the SAME provider+model the chat is currently on (no Haiku
    // hardcode — minimizes future tech debt when models change). On any
    // failure (no provider creds, classifier timeout, parse error) we
    // FAIL OPEN and proceed — better to allow the occasional misuse than
    // to block legitimate self_edits when the classifier is flaky.
    const lastUserMessage = typeof args._lastUserMessage === "string" ? args._lastUserMessage : "";
    const lastAssistantMessage = typeof args._lastAssistantMessage === "string" ? args._lastAssistantMessage : "";
    if (lastUserMessage) {
      try {
        const verdict = await checkSelfEditIntent(task, lastUserMessage, lastAssistantMessage);
        if (verdict?.verdict === "mismatch") {
          return {
            content:
              `BLOCKED — the self_edit task doesn't match what the user is asking for.\n\n` +
              `User's most recent message: "${lastUserMessage.slice(0, 200)}${lastUserMessage.length > 200 ? "..." : ""}"\n` +
              `Self_edit task you submitted: "${task.slice(0, 200)}${task.length > 200 ? "..." : ""}"\n` +
              `Reason: ${verdict.reason}\n\n` +
              `If the user wants the change you described, they need to ask for it explicitly. ` +
              `If you misread their intent, use a different tool. ` +
              `Common misroutes: "launch installer" → install_software strategy='launch', "run command" → bash, "edit workspace file" → edit, "change setting" → http_request to /api/settings.`,
            isError: true,
          };
        }
      } catch { /* classifier unavailable — fail open */ }
    }

    // Per-session live-call guard. If another self_edit is already running for
    // this session, refuse the new call. Prevents the parallel-worktree mess
    // when a slow self_edit tempts the model to retry.
    const sessionId = typeof args._sessionId === "string" ? args._sessionId : "";
    if (sessionId) {
      const live = getActiveSelfEdit(sessionId);
      if (live) return buildLiveCallBlockedResponse(live);
      acquireSelfEditLock(sessionId, task);
    }

    const scopeHintArg = String(args.scope_hint || "").trim();
    // Internal (server-injected) overrides — NOT in the public tool schema:
    //   _cwd:    autopilot routes self_edit into its worktree path
    //   _unsafe: emergency rescue mode (skip the sandbox + gates)
    // The model itself can't set either — only the tool router can.
    const internalCwd = typeof args._cwd === "string" && args._cwd.trim() ? args._cwd : null;
    const unsafe = args._unsafe === true;

    const fullPrompt = await buildSelfEditPrompt(task, scopeHintArg);

    // Release the per-session live-call lock no matter how this function
    // exits — sandbox path, bypass success, spawn error, timeout. Without a
    // finally the lock would leak on the early returns and permanently block
    // the session from issuing another self_edit.
    const releaseLock = () => { if (sessionId) releaseSelfEditLock(sessionId); };

    try {
      // Default flow: sandboxed via worktree + 3-gate validation. Skipped when
      // _cwd is set (autopilot already provides isolation) or _unsafe is set.
      if (!internalCwd && !unsafe) {
        const { runSelfEditInSandbox, formatSandboxResult } = await import("../self-edit-sandbox.js");
        const { getRuntimeConfig } = await import("../config.js");
        const authToken = getRuntimeConfig().authToken;
        const result = await runSelfEditInSandbox({
          task, scopeHint: scopeHintArg, signal,
          fullPrompt, authToken,
        });
        return { content: formatSandboxResult(result), isError: !result.ok };
      }

      // Bypass flow: write directly to the supplied cwd (autopilot worktree
      // OR LAX_REPO_ROOT for unsafe rescues). No gates.
      const subprocessCwd = internalCwd || LAX_REPO_ROOT;
      return await runSelfEditBypass(subprocessCwd, fullPrompt, signal);
    } finally {
      releaseLock();
    }
  },
};
