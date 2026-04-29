import type { ToolDefinition } from "../types.js";

// ── Smart Tool Filtering ──
// Always include core tools. Add extras if the user's message hints at them.
// tool_search is always included so the agent can discover anything else.

export const CORE_TOOL_NAMES = new Set([
  // Filesystem & code
  "read", "write", "edit", "bash", "glob", "grep",
  // Web & search
  "web_fetch", "web_search",
  // Interaction
  "ask_user", "tool_search",
  // Vision
  "view_image", "screen_capture",
  // Memory
  "memory_search", "memory_save", "memory_recall", "memory_get",
  "memory_forget", "memory_reflect", "memory_update_profile", "memory_stats",
  "memory_consolidate", "memory_ingest",
  // Operations — long-horizon goal orchestration
  "operation_start", "operation_list", "operation_status", "operation_next", "operation_advance",
  // Worker pool — delegate heavy work to isolated subprocess (chat stays responsive)
  // op_submit_async is the PRIMARY verb (non-blocking); op_wait is the explicit
  // blocker; op_submit is sugar (= async + immediate wait) for short ops only.
  "op_submit", "op_submit_async", "op_wait", "op_status", "op_kill", "op_redirect",
  // Autopilot — bounded autonomous work in isolated worktree
  "autopilot_start", "autopilot_stop", "autopilot_status",
  // Self-edit (sandboxed code repair via subprocess)
  "self_edit",
  // Planning & tasks
  "enter_plan_mode", "exit_plan_mode",
  "task_create", "task_update", "task_list", "task_get",
  // Protocols & scheduling
  "protocol_list", "protocol_get",
  "mission_schedule_create", "mission_schedule_list", "mission_schedule_update",
  "mission_schedule_delete", "mission_schedule_toggle",
  // Agents
  "agent_spawn", "delegate", "agent_status", "agent_cancel", "agent_message", "agent_output",
  // Browser
  "browser",
  // Apps
  "build_app", "app_create", "app_list",
  // Secrets
  "request_secret", "list_secrets",
  // HTTP
  "http_request",
]);

// Keywords that trigger including specific tool groups
const TOOL_KEYWORD_MAP: Array<{ keywords: RegExp; toolPrefixes: string[] }> = [
  { keywords: /spreadsheet|excel|xlsx|csv|sheet/i, toolPrefixes: ["spreadsheet_"] },
  { keywords: /document|docx|word/i, toolPrefixes: ["document_"] },
  { keywords: /presentation|slide|pptx|powerpoint/i, toolPrefixes: ["presentation_"] },
  { keywords: /pdf/i, toolPrefixes: ["pdf_"] },
  { keywords: /email|mail|inbox|send.*email/i, toolPrefixes: ["email_"] },
  { keywords: /calendar|event|meeting|schedule.*event/i, toolPrefixes: ["calendar_"] },
  { keywords: /clipboard|copy|paste/i, toolPrefixes: ["clipboard_"] },
  { keywords: /sql|database|query.*table|postgres|sqlite/i, toolPrefixes: ["sql_"] },
  { keywords: /image|photo|generate.*image|draw|picture/i, toolPrefixes: ["generate_image", "generate_video", "ocr"] },
  { keywords: /camera|webcam/i, toolPrefixes: ["camera_"] },
  // App tools surface on "app/dashboard/tracker" mentions. Sidebar tools are a
  // SEPARATE rule that requires an explicit sidebar/pin/unpin keyword — the
  // old combined rule was the root cause of Codex reflexively pinning apps
  // to the sidebar whenever the user said anything with "app" in it (e.g.
  // "use this image as the background for my to-do app" → model sees
  // sidebar_pin available + description says "use when user says add" →
  // misroutes to pin).
  { keywords: /\bapp\b|dashboard|tracker/i, toolPrefixes: ["app_"] },
  { keywords: /\bsidebar\b|\bpin\b|\bunpin\b/i, toolPrefixes: ["sidebar_"] },
  { keywords: /issue|ticket|project|kanban/i, toolPrefixes: ["issue_"] },
  { keywords: /instagram|twitter|tiktok|social|post on/i, toolPrefixes: ["mission_"] },
  { keywords: /config|setting/i, toolPrefixes: ["config_"] },
  { keywords: /skill/i, toolPrefixes: ["skill_"] },
  { keywords: /rollback|undo.*mission/i, toolPrefixes: ["mission_rollback_"] },
  { keywords: /chain|pipeline/i, toolPrefixes: ["mission_chain_"] },
  { keywords: /template/i, toolPrefixes: ["mission_template"] },
  { keywords: /marketplace/i, toolPrefixes: ["marketplace_"] },
  { keywords: /agency|team|hire/i, toolPrefixes: ["agency_"] },
];

// Build intent = minimal tool set. When the user asks to build/create an app,
// the agent only needs file operations. Fewer tools = smaller context = Codex
// stops returning empty responses on complex prompts.
const BUILD_INTENT_TOOLS = new Set([
  // build_app is the primary tool for new apps — spawns CLI subprocess for reliability
  "build_app",
  // Direct file tools for edits and simple tasks
  "write", "edit", "read", "bash", "glob", "grep",
  "web_fetch", "web_search", "tool_search",
  "ask_user", "view_image",
]);
const BUILD_INTENT_REGEX = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script)/i;

export function filterToolsForMessage(allTools: ToolDefinition[], message: string): ToolDefinition[] {
  // Build intent: ultra-minimal tool set (~11 tools vs 40+)
  // This is critical for Codex which returns empty responses when context is bloated
  if (BUILD_INTENT_REGEX.test(message)) {
    return allTools.filter(t => BUILD_INTENT_TOOLS.has(t.name));
  }

  const included = new Set<string>();

  // Always include core tools
  for (const name of CORE_TOOL_NAMES) included.add(name);

  // Add tools matching user message keywords
  for (const { keywords, toolPrefixes } of TOOL_KEYWORD_MAP) {
    if (keywords.test(message)) {
      for (const tool of allTools) {
        for (const prefix of toolPrefixes) {
          if (tool.name.startsWith(prefix) || tool.name === prefix) {
            included.add(tool.name);
          }
        }
      }
    }
  }

  return allTools.filter(t => included.has(t.name));
}
