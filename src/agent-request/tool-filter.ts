import type { ToolDefinition } from "../types.js";
import { resolveToolsForRequest } from "../tool-search.js";

// ── Smart Tool Filtering ──
// Always include core tools. Add extras if the user's message hints at them.
// tool_search is always included so the agent can discover anything else.

/**
 * Tools that must NEVER be surfaced to the main-chat supervisor (Primal),
 * regardless of keyword match, literal call detection, or tool-RAG
 * semantic retrieval. Enforced at the END of filterToolsForMessage and
 * mirrored in prepare-request.ts where the tool-RAG union is computed.
 *
 * `agency_*` predates the canonical agent design (docs/canonical-agent-design.md)
 * which locked in agent_list / agent_spawn / agent_create as the THREE
 * delegation primitives. `agency_create` overlaps with `agent_spawn` —
 * description-similarity high enough that Claude (more than Codex) often
 * picks the heavier agency path for one-off tasks. The agency layer is
 * still programmatically callable; it just doesn't appear in Primal's
 * tool schema. (Live failure: 2026-05-12 — "spawn a researcher to find
 * the capital of France" routed via Anthropic CLI hung 135s on
 * agency_create when agent_spawn would have answered in seconds.)
 */
export const SUPERVISOR_EXCLUDED: ReadonlySet<string> = new Set([
  "agency_create", "agency_status", "agency_cancel",
  "agency_list_roles", "agency_result",
]);

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
  // Worker-pool observation tools — kept so the supervisor can monitor
  // and cancel ops spawned by autopilot, scheduled tasks, or other
  // internal callers. The submission tools (op_submit / op_submit_async /
  // op_wait) are intentionally NOT exposed: per docs/canonical-agent-design.md
  // Q1, delegation goes through agent_spawn (canonical layer). Internal
  // code paths that need worker-pool dispatch can call submitOp directly.
  "op_status", "op_kill", "op_redirect",
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
  // Agents — canonical delegation surface. agent_spawn is the ONE way
  // the supervisor delegates work to a specialist; agent_list discovers
  // the catalog before spawning; agent_create extends it when no role
  // fits. agent_status / agent_cancel / agent_output observe and control
  // running spawns. Anything matching a named role (or the generic
  // "worker") goes through this path — never op_submit_async.
  //
  // 🔄 REVERSE UNO — this line is the lever. For five layers of
  // canonical-agent work we built the tool surface, taught the prompt
  // to use it, wrote the tests — and Primal still routed through
  // op_submit_async because THIS gate was stripping agent_spawn out of
  // the request payload. Flipping the include/exclude here is what
  // finally made the canonical path load-bearing. The actual fix was
  // one file. (Peter's call, 2026-05-11.)
  "agent_list", "agent_spawn", "agent_create",
  "agent_status", "agent_cancel", "agent_output",
  // Browser
  "browser",
  // Apps
  "build_app", "app_create", "app_list",
  // Auto-build orchestrator — entrypoints for /app-build → spec → plan →
  // chunk-runner loop. These MUST be in the per-turn tool schema, not
  // gated by keyword, because the user often pastes a literal tool call
  // (e.g. primal_run_build_plan({...})) which doesn't match any keyword
  // regex. Without these, Codex says "tool isn't in my loaded schema"
  // even though tool_search returns the def — burning a turn and looking
  // broken. (Live failure: 2026-05-12.)
  "primal_run_build_plan", "primal_build_status", "primal_build_resume",
  "start_app_build", "finalize_app_build",
  // Secrets
  "request_secret", "request_secrets", "list_secrets",
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
export const BUILD_INTENT_TOOLS = new Set([
  // build_app is the primary tool for new apps — spawns CLI subprocess for reliability
  "build_app",
  // Direct file tools for edits and simple tasks
  "write", "edit", "read", "bash", "glob", "grep",
  "web_fetch", "web_search", "tool_search",
  "ask_user", "view_image",
  // self_edit lets Primal route around protected-files for src/ edits inside a
  // sandboxed worktree with build/server-bind/agent-smoke gates before merge.
  "self_edit",
  // Canonical delegation surface — build-intent messages can still
  // delegate long-running research/build work to a named specialist
  // (e.g. a coder agent) without falling back to blocking calls.
  "agent_list", "agent_spawn", "agent_create",
  "agent_status", "agent_kill",
]);
const BUILD_INTENT_REGEX = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script)/i;

/**
 * Detect literal tool-call syntax in the user message and return any
 * exact tool names referenced. Catches the pattern `tool_name({...})` —
 * when the user pastes a tool call directly, we MUST include that tool
 * regardless of keyword filters or build-intent strip-down. Otherwise
 * the model sees "tool not in my schema" and routes to self_edit /
 * tool_search to try to "investigate."
 */
function detectLiteralToolCalls(message: string, allTools: ToolDefinition[]): Set<string> {
  const out = new Set<string>();
  const re = /\b([a-z_][a-z0-9_]+)\s*\(\s*\{/gi;
  const known = new Set(allTools.map(t => t.name));
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    if (known.has(m[1])) out.add(m[1]);
  }
  return out;
}

/**
 * Pure keyword router — given a user message + the full tool list,
 * return the set of tool names matched by TOOL_KEYWORD_MAP. Extracted
 * from filterToolsForMessage so resolveToolsForRequest can inject it
 * as a dependency without circular imports.
 */
function keywordRouter(message: string, allTools: ToolDefinition[]): Set<string> {
  const out = new Set<string>();
  for (const { keywords, toolPrefixes } of TOOL_KEYWORD_MAP) {
    if (keywords.test(message)) {
      for (const tool of allTools) {
        for (const prefix of toolPrefixes) {
          if (tool.name.startsWith(prefix) || tool.name === prefix) {
            out.add(tool.name);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Back-compat shim. Delegates to resolveToolsForRequest with
 * audience="main-chat" and the keyword/literal/build-intent helpers
 * wired in. Keeps existing callers working during P1.C3/C4 migration.
 *
 * Verified byte-identical to the pre-migration implementation for the
 * 10 representative messages in test/tool-filter-parity.test.ts.
 */
export function filterToolsForMessage(allTools: ToolDefinition[], message: string): ToolDefinition[] {
  const resolved = resolveToolsForRequest(
    {
      audience: "main-chat",
      message,
      keywordRouter,
      literalCallDetector: detectLiteralToolCalls,
      buildIntentTest: (m) => BUILD_INTENT_REGEX.test(m),
    },
    allTools,
  );
  return resolved.filter(t => !SUPERVISOR_EXCLUDED.has(t.name));
}
