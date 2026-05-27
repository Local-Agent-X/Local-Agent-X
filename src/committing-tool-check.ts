// Detects whether a completed agent turn already performed a committing
// (non-idempotent, user-visible) tool call. Used by the chat route to
// suppress auto-failover after side effects — replaying the turn on a
// different provider would re-execute the tool (double email, double
// delete, double API call).
//
// Philosophy: be conservative. When in doubt, treat as committing. Missing
// an auto-failover is annoying; double-sending an email is worse.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

/** Tools whose invocation MUST NOT be auto-replayed on a fallback provider. */
const COMMITTING_TOOLS = new Set<string>([
  "email_send",
  "email_setup",
  "secret_save",
  "secret_delete",
  "browser_capture_to_secret",
  "browser_fill_from_secret",
  "sidebar_pin",
  "sidebar_unpin",
  "sidebar_clear",
  "memory_save",
  "memory_update_profile",
  "memory_set_user_field",
  "remember",
  "update_fact",
  "forget",
  "cron_create",
  "cron_delete",
  "cron_update",
  "agent_spawn",
  "delegate",
  "operation_start",
  "build_app",
  "write",
  "edit",
  "bash",
  "self_edit",
  "whatsapp_send",
  "telegram_send",
]);

const COMMITTING_HTTP_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

const COMMITTING_BROWSER_ACTION_BUTTONS = /\b(send|submit|pay|confirm|delete|checkout|publish|post|buy|purchase|remove|transfer|sign\s*up|register)\b/i;

interface AssistantMessageWithToolCalls {
  role: "assistant";
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

export interface CommittingFinding {
  toolName: string;
  reason: string;
}

/** Scan a completed turn's messages for any committing tool calls. */
export function detectCommittingCalls(
  messages: ChatCompletionMessageParam[],
): CommittingFinding[] {
  const findings: CommittingFinding[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const tcs = (m as unknown as AssistantMessageWithToolCalls).tool_calls;
    if (!tcs || !Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      const name = tc.function?.name || "";
      if (!name) continue;

      if (COMMITTING_TOOLS.has(name)) {
        findings.push({ toolName: name, reason: `${name} is non-idempotent` });
        continue;
      }

      // http_request is idempotent for GET/HEAD but not for POST/PUT/DELETE/PATCH
      if (name === "http_request") {
        try {
          const args = JSON.parse(tc.function?.arguments || "{}");
          const method = String(args.method || "GET").toUpperCase();
          if (COMMITTING_HTTP_METHODS.has(method)) {
            const url = String(args.url || "").slice(0, 120);
            findings.push({ toolName: name, reason: `${method} ${url}` });
          }
        } catch { /* unparseable args — err on the side of committing */
          findings.push({ toolName: name, reason: "http_request with unparseable args" });
        }
        continue;
      }

      // browser tool: look for clicks on commit-style buttons
      if (name === "browser") {
        try {
          const args = JSON.parse(tc.function?.arguments || "{}");
          const action = String(args.action || "");
          if (action === "click" || action === "click_text" || action === "act") {
            const target = String(args.text || args.value || args.selector || "");
            if (COMMITTING_BROWSER_ACTION_BUTTONS.test(target)) {
              findings.push({ toolName: name, reason: `browser.${action} on "${target.slice(0, 60)}"` });
            }
          }
        } catch { /* ignore unparseable */ }
      }
    }
  }
  return findings;
}

/** Convenience: true if ANY committing call was made this turn. */
export function turnPerformedCommittingCall(
  messages: ChatCompletionMessageParam[],
): boolean {
  return detectCommittingCalls(messages).length > 0;
}

/** True if a single tool name is in the committing set. Lets detectors
 *  ask "did this turn commit anything yet?" without re-scanning messages. */
export function isCommittingTool(name: string): boolean {
  return COMMITTING_TOOLS.has(name);
}
