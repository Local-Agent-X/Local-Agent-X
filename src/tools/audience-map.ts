import type { Audience, ToolDefinition } from "../types.js";

/**
 * Canonical source of truth for tool→audience tagging.
 *
 * Each entry says "this tool appears in the per-request schema for these
 * audiences" — exhaustive. A tool absent from this map is deferred (loaded
 * only via tool_search).
 *
 * Audiences:
 *   - main-chat:     Primal's per-turn schema (filtered by message/keyword)
 *   - spawned-agent: agent_spawn sub-agents
 *   - operator:      Operations-phase workers (narrower file/web/memory set)
 *   - build-intent:  strip-down applied when Primal's message matches "build me X"
 */
export const AUDIENCES_BY_TOOL: Record<string, Audience[]> = {
  // Filesystem & code
  read:        ["main-chat", "spawned-agent", "operator", "build-intent"],
  write:       ["main-chat", "spawned-agent", "operator", "build-intent"],
  edit:        ["main-chat", "spawned-agent", "operator", "build-intent"],
  delete_file: ["main-chat"],
  bash:        ["main-chat", "spawned-agent", "operator", "build-intent"],
  glob:        ["main-chat", "build-intent"],
  grep:        ["main-chat", "build-intent"],

  // Web & search
  web_fetch:   ["main-chat", "spawned-agent", "operator", "build-intent"],
  web_search:  ["main-chat", "spawned-agent", "operator", "build-intent"],
  http_request: ["main-chat", "spawned-agent", "operator"],

  // App self-control
  setting:     ["main-chat", "spawned-agent", "operator"],

  // Tool discovery
  tool_search: ["main-chat", "build-intent"],

  // Vision
  view_image:     ["main-chat", "spawned-agent", "operator", "build-intent"],
  send_video:     ["main-chat"],
  screen_capture: ["main-chat"],
  ocr:            ["spawned-agent", "operator"],

  // Memory
  memory_search:         ["main-chat", "spawned-agent", "operator"],
  memory_save:           ["main-chat", "spawned-agent", "operator"],
  memory_recall:         ["main-chat", "spawned-agent", "operator"],
  memory_get:            ["main-chat"],
  memory_forget:         ["main-chat"],
  memory_reflect:        ["main-chat"],
  memory_update_profile: ["main-chat"],
  memory_stats:          ["main-chat"],
  memory_consolidate:    ["main-chat"],
  memory_dream:          ["main-chat"],
  memory_ingest:         ["main-chat"],

  // Operations — long-horizon goal orchestration
  operation_start:   ["main-chat"],
  operation_list:    ["main-chat"],
  operation_status:  ["main-chat"],
  operation_next:    ["main-chat"],
  operation_advance: ["main-chat"],

  // Worker-pool observation (submit lives in canonical, not exposed)
  op_status:   ["main-chat"],
  op_kill:     ["main-chat"],
  op_redirect: ["main-chat"],

  // Autopilot
  autopilot_start:  ["main-chat"],
  autopilot_stop:   ["main-chat"],
  autopilot_status: ["main-chat"],

  // Self-edit
  self_edit: ["main-chat", "build-intent"],

  // Planning & tasks
  enter_plan_mode: ["main-chat"],
  exit_plan_mode:  ["main-chat"],
  task_create:     ["main-chat"],
  task_update:     ["main-chat"],
  task_list:       ["main-chat"],
  task_get:        ["main-chat"],

  // Protocols
  protocol_list:           ["main-chat"],
  protocol_get:            ["main-chat"],
  protocol_search:         ["main-chat"],
  protocol_create:         ["main-chat"],
  protocol_edit:           ["main-chat"],
  protocol_delete:         ["main-chat"],
  protocol_unarchive:      ["main-chat"],
  protocol_pin:            ["main-chat"],
  protocol_list_archived:  ["main-chat"],
  protocol_stats:          ["main-chat"],
  protocol_prune:          ["main-chat"],
  protocol_archive_bulk:   ["main-chat"],
  protocol_curate:         ["main-chat"],
  protocol_curator_status: ["main-chat"],

  // Mission scheduling
  mission_schedule_create: ["main-chat"],
  mission_schedule_list:   ["main-chat"],
  mission_schedule_update: ["main-chat"],
  mission_schedule_delete: ["main-chat"],
  mission_schedule_toggle: ["main-chat"],

  // Agents — canonical delegation surface
  agent_list:   ["main-chat", "build-intent"],
  agent_spawn:  ["main-chat", "build-intent"],
  agent_create: ["main-chat", "build-intent"],

  // Project containers (sibling to agent_* — same eager visibility)
  project_create:    ["main-chat", "build-intent"],
  project_list:      ["main-chat", "build-intent"],
  project_add_agent: ["main-chat", "build-intent"],
  agent_status: ["main-chat", "build-intent"],
  agent_cancel: ["main-chat"],
  agent_output: ["main-chat"],
  agent_kill:   ["build-intent"],

  // Browser
  browser: ["main-chat", "spawned-agent", "operator"],

  // Apps
  build_app: ["main-chat", "build-intent"],
  app_create: ["main-chat"],
  app_list:   ["main-chat"],

  // Sidebar — eager main-chat visibility. The keyword router
  // (tool-filter.ts) used to be the only path that surfaced these, but
  // Grok refused to call sidebar_clear on a message containing the word
  // "sidebar" because the indirect route was unreliable. Eager is the
  // right default for user-facing app-state mutations anyway.
  sidebar_pin:   ["main-chat"],
  sidebar_unpin: ["main-chat"],
  sidebar_clear: ["main-chat"],

  // Auto-build orchestrator
  primal_run_build_plan: ["main-chat"],
  primal_build_status:   ["main-chat"],
  primal_build_resume:   ["main-chat"],
  start_app_build:       ["main-chat"],
  finalize_app_build:    ["main-chat"],

  // Secrets
  request_secret:  ["main-chat"],
  request_secrets: ["main-chat"],
  list_secrets:    ["main-chat"],

  // Document creation (only document_* is main-chat eager; spreadsheet/pdf
  // surface via keyword router for main-chat, eagerly for operator)
  document_create: ["main-chat", "spawned-agent", "operator"],
  document_edit:   ["main-chat", "spawned-agent", "operator"],
  document_read:   ["main-chat"],

  // Operator-only specialty tools
  spreadsheet_read:  ["spawned-agent", "operator"],
  spreadsheet_write: ["spawned-agent", "operator"],
  pdf_create:        ["spawned-agent", "operator"],
  email_send:        ["spawned-agent", "operator"],
};

/**
 * Stamp each tool's `audiences` field from the canonical map.
 * Called once at registry build time. Idempotent.
 */
export function applyAudiences(tools: ToolDefinition[]): void {
  for (const tool of tools) {
    const audiences = AUDIENCES_BY_TOOL[tool.name];
    if (audiences) tool.audiences = audiences;
  }
}
