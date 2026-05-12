/**
 * Tool-filter migration parity test (AUDIT Cluster 11, P1.C3).
 *
 * Verifies that filterToolsForMessage (now a shim over
 * resolveToolsForRequest) produces the same tool list as the
 * pre-migration implementation for 10 representative messages.
 *
 * The pre-migration logic is recreated inline (replicaFilter) so this
 * test compares the new path against the old path within the same
 * process. If anyone changes resolveToolsForRequest in a way that
 * breaks the existing contract, this test catches it.
 */

import { describe, it, expect } from "vitest";
import { filterToolsForMessage } from "../src/agent-request/tool-filter.js";
import type { Audience, ToolDefinition } from "../src/types.js";

// Stub tool list mirroring real tools, with audiences pre-set as
// tagToolsByAudience would set them. These ARE the tags the resolver
// reads — keeping them inline avoids depending on registry-build.ts's
// side effects in test.
function mkTool(name: string, audiences?: Audience[]): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: {},
    audiences,
    async execute() { return { content: "" }; },
  };
}

const CORE_NAMES = new Set([
  "read", "write", "edit", "bash", "glob", "grep",
  "web_fetch", "web_search", "ask_user", "tool_search",
  "view_image", "screen_capture",
  "memory_search", "memory_save", "memory_recall", "memory_get",
  "memory_forget", "memory_reflect", "memory_update_profile", "memory_stats",
  "memory_consolidate", "memory_ingest",
  "operation_start", "operation_list", "operation_status", "operation_next", "operation_advance",
  "op_status", "op_kill", "op_redirect",
  "autopilot_start", "autopilot_stop", "autopilot_status",
  "self_edit",
  "enter_plan_mode", "exit_plan_mode",
  "task_create", "task_update", "task_list", "task_get",
  "protocol_list", "protocol_get",
  "mission_schedule_create", "mission_schedule_list", "mission_schedule_update",
  "mission_schedule_delete", "mission_schedule_toggle",
  "agent_list", "agent_spawn", "agent_create",
  "agent_status", "agent_cancel", "agent_output",
  "browser",
  "build_app", "app_create", "app_list",
  "primal_run_build_plan", "primal_build_status", "primal_build_resume",
  "start_app_build", "finalize_app_build",
  "request_secret", "request_secrets", "list_secrets",
  "http_request",
]);
const BUILD_INTENT_NAMES = new Set([
  "build_app", "write", "edit", "read", "bash", "glob", "grep",
  "web_fetch", "web_search", "tool_search",
  "ask_user", "view_image", "self_edit",
  "agent_list", "agent_spawn", "agent_create",
  "agent_status", "agent_kill",
]);
const PREFIXES_BY_KEYWORD: Array<{ re: RegExp; prefixes: string[] }> = [
  { re: /spreadsheet|excel|xlsx|csv|sheet/i, prefixes: ["spreadsheet_"] },
  { re: /document|docx|word/i, prefixes: ["document_"] },
  { re: /pdf/i, prefixes: ["pdf_"] },
  { re: /email|mail|inbox|send.*email/i, prefixes: ["email_"] },
  { re: /calendar|event|meeting|schedule.*event/i, prefixes: ["calendar_"] },
  { re: /\bsidebar\b|\bpin\b|\bunpin\b/i, prefixes: ["sidebar_"] },
  { re: /\bapp\b|dashboard|tracker/i, prefixes: ["app_"] },
];

// Build the test tool list with audiences set the same way
// tagToolsByAudience does at runtime.
function buildTestToolList(): ToolDefinition[] {
  const allNames = new Set<string>();
  for (const n of CORE_NAMES) allNames.add(n);
  for (const n of BUILD_INTENT_NAMES) allNames.add(n);
  // Add some keyword-routed tools so the keyword path is observable.
  for (const n of [
    "spreadsheet_read", "spreadsheet_write",
    "document_create", "document_edit",
    "pdf_create", "pdf_extract",
    "email_send", "email_read",
    "calendar_create", "calendar_list",
    "sidebar_pin", "sidebar_unpin",
    "app_create", "app_list",
  ]) allNames.add(n);

  return [...allNames].map(name => {
    const audiences: Audience[] = [];
    if (CORE_NAMES.has(name)) audiences.push("main-chat");
    if (BUILD_INTENT_NAMES.has(name)) audiences.push("build-intent");
    return mkTool(name, audiences.length ? audiences : undefined);
  });
}

// Pure replica of the pre-migration filterToolsForMessage.
function replicaFilter(allTools: ToolDefinition[], message: string): ToolDefinition[] {
  const literalCalls = new Set<string>();
  const re = /\b([a-z_][a-z0-9_]+)\s*\(\s*\{/gi;
  const known = new Set(allTools.map(t => t.name));
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    if (known.has(m[1])) literalCalls.add(m[1]);
  }

  const BUILD_RE = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script)/i;
  if (BUILD_RE.test(message) && literalCalls.size === 0) {
    return allTools.filter(t => BUILD_INTENT_NAMES.has(t.name));
  }

  const included = new Set<string>();
  for (const name of CORE_NAMES) included.add(name);
  for (const name of literalCalls) included.add(name);
  for (const { re: kw, prefixes } of PREFIXES_BY_KEYWORD) {
    if (kw.test(message)) {
      for (const tool of allTools) {
        for (const p of prefixes) {
          if (tool.name.startsWith(p) || tool.name === p) included.add(tool.name);
        }
      }
    }
  }
  return allTools.filter(t => included.has(t.name));
}

const MESSAGES = [
  "hi",
  "what's 2+2",
  "build me an app",
  "send an email to the team",
  'primal_run_build_plan({"project_dir":"mygroomtime"})',
  "open my spreadsheet",
  "pin this to sidebar",
  "check my calendar",
  "what's the weather",
  "refactor this function",
];

describe("filterToolsForMessage parity (P1.C3)", () => {
  const tools = buildTestToolList();
  for (const msg of MESSAGES) {
    it(`byte-identical for: ${JSON.stringify(msg).slice(0, 60)}`, () => {
      const fromShim = filterToolsForMessage(tools, msg).map(t => t.name).sort();
      const fromReplica = replicaFilter(tools, msg).map(t => t.name).sort();
      expect(fromShim).toEqual(fromReplica);
    });
  }
});
