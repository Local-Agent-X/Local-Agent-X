// Detects whether a completed agent turn already performed a committing
// (non-idempotent, user-visible) tool call. Used by the chat route to
// suppress auto-failover after side effects — replaying the turn on a
// different provider would re-execute the tool (double email, double
// delete, double API call) — and by the mid-turn-stale safety brake to
// avoid aborting turns that already dispatched real work.
//
// Philosophy: be conservative. When in doubt, treat as committing. Missing
// an auto-failover is annoying; double-sending an email is worse.
//
// Single source of truth: tool-registry.ts. Each tool's `risk` decides
// whether it commits. The hand-maintained list this module used to keep
// drifted: agency_create, task_create, issue_create, agent_team_*, and
// most protocol/mission/spreadsheet writers were missing, so the safety
// brake didn't credit them as progress and aborted turns mid-work
// (Nutrishop demo, 2026-05-27). Deriving from the registry kills that
// drift class — adding a tool to tool-registry.ts is the one and only
// step needed for every downstream consumer.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { TOOLS, type ToolRisk } from "./tool-registry.js";

/** Risk classes that count as committing for failover + progress checks. */
const COMMITTING_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>([
  "workspace-write",
  "network-write",
  "shell",
  "destructive",
  "money",
  "external-comms",
  "secrets",
]);

/** Tools whose risk classification is too coarse — they need arg-aware
 *  inspection to decide committingness. detectCommittingCalls handles
 *  these properly with method/action checks; at the name-only
 *  isCommittingTool layer we conservatively return false (matches the
 *  pre-derivation behavior). Callers with args available should prefer
 *  detectCommittingCalls. */
const ARG_AWARE_TOOLS: ReadonlySet<string> = new Set<string>([
  "http_request",  // GET/HEAD idempotent; POST/PUT/DELETE/PATCH committing
  "browser",       // click on commit-style buttons is committing
]);

/** Explicit overrides for tool names referenced elsewhere in the codebase
 *  (loop-detection.ts, action-claim.ts) that are NOT in tool-registry.ts.
 *  Either legacy names from a prior rename or planned-but-unimplemented
 *  tools. When one of these lands in the registry with a committing-risk
 *  classification, remove it from here — the derivation will cover it. */
const LEGACY_COMMITTING_OVERRIDES: ReadonlySet<string> = new Set<string>([
  "secret_save", "secret_delete",
  "cron_create", "cron_delete", "cron_update",
  "whatsapp_send", "telegram_send",
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

      // Arg-aware checks below own http_request / browser. Everything else
      // defers to isCommittingTool, which derives from the registry plus
      // legacy overrides.
      if (!ARG_AWARE_TOOLS.has(name) && isCommittingTool(name)) {
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

/** True if a single tool name is committing. Lets detectors ask "did this
 *  turn commit anything yet?" without re-scanning messages.
 *
 *  Decision order:
 *    1. Legacy override Set (for tools not yet in tool-registry).
 *    2. Arg-aware tools (http_request, browser) return false here —
 *       they need args for an accurate verdict; use detectCommittingCalls
 *       when args are in scope.
 *    3. Registry-derived: any tool whose `risk` is in COMMITTING_RISKS. */
export function isCommittingTool(name: string): boolean {
  if (LEGACY_COMMITTING_OVERRIDES.has(name)) return true;
  if (ARG_AWARE_TOOLS.has(name)) return false;
  const entry = TOOLS[name];
  if (!entry) return false;
  return COMMITTING_RISKS.has(entry.risk);
}
