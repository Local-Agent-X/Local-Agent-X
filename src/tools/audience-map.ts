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
  edit_lines:  ["main-chat", "spawned-agent", "operator", "build-intent"],
  multi_edit:  ["main-chat", "spawned-agent", "operator", "build-intent"],
  delete_file: ["main-chat"],
  bash:        ["main-chat", "spawned-agent", "operator", "build-intent"],
  // glob/grep reach spawned agents too: the enforcement layer already
  // path-rewrites them for `agent-` sessions (enforce-policy.rewriteWorktreePaths),
  // and a code-working sub-agent that can only shell out via bash is degraded
  // vs main-chat. Read-only discovery (ARI action "read"), spiral-guarded.
  glob:        ["main-chat", "spawned-agent", "build-intent"],
  grep:        ["main-chat", "spawned-agent", "build-intent"],

  // Web & search
  web_fetch:   ["main-chat", "spawned-agent", "operator", "build-intent"],
  web_search:  ["main-chat", "spawned-agent", "operator", "build-intent"],
  image_search: ["main-chat", "spawned-agent", "operator", "build-intent"],
  create_chart: ["main-chat", "spawned-agent", "operator", "build-intent"],
  preview_document: ["main-chat", "spawned-agent", "operator", "build-intent"],
  http_request: ["main-chat", "spawned-agent", "operator"],

  // App self-control
  setting:     ["main-chat", "spawned-agent", "operator"],

  // Tool discovery. Eager for spawned agents too — without it a sub-agent
  // (esp. a weak non-Anthropic model that declines capabilities tool-lessly)
  // can never reach ANY deferred tool, so it's strictly worse than main-chat.
  // The tool-search-nudge middleware that forces weak models to search assumes
  // this is present. Allow-listed templates stay authoritative (this only
  // affects the no-allowlist default surface).
  tool_search: ["main-chat", "spawned-agent", "build-intent"],

  // Vision
  view_image:     ["main-chat", "spawned-agent", "operator", "build-intent"],
  send_video:     ["main-chat"],
  send_image:     ["main-chat"],
  screen_capture: ["main-chat"],
  // computer (mouse/keyboard) is intentionally DEFERRED — found via tool_search.
  // The tool-search-nudge middleware forces models that decline a capability
  // tool-lessly (e.g. Grok) to search first, so it doesn't need an eager slot.
  // Proactive owner DM — interactive ("ping me…") AND autonomous/scheduled runs.
  telegram_send:  ["main-chat", "operator", "spawned-agent"],
  whatsapp_send:  ["main-chat", "operator", "spawned-agent"],
  // Platform self-management — interactive ("restart" / "check for updates") and
  // scheduled (a nightly update check). Not spawned-agent (sub-agents must not
  // restart the host).
  restart:           ["main-chat", "operator"],
  check_for_updates: ["main-chat", "operator"],
  apply_update:      ["main-chat", "operator"],
  ocr:            ["spawned-agent", "operator"],

  // Memory
  memory_search:         ["main-chat", "spawned-agent", "operator"],
  // Cross-session recall + date-scoped lookup must be EAGER, not deferred —
  // otherwise the model (esp. non-Anthropic providers on the bridge) can't
  // answer "what did we do on <date>" because the only tool that pulls prior
  // sessions never reaches its schema. This is the date-recall surfacing fix.
  search_past_sessions:  ["main-chat", "spawned-agent", "operator"],
  read_my_logs:          ["main-chat", "spawned-agent"],
  memory_save:           ["main-chat", "spawned-agent", "operator"],
  memory_recall:         ["main-chat", "spawned-agent", "operator"],
  memory_get:            ["main-chat"],
  memory_forget:         ["main-chat"],
  // memory maintenance ops (reflect/update_profile/stats/consolidate/dream/
  // ingest) are deferred — rare, admin-shaped, reachable via tool_search or a
  // pasted literal call. 2026-06 usage telemetry should confirm before any
  // come back.


  // Worker-pool observation (submit lives in canonical, not exposed).
  // op_kill/op_redirect stay EAGER: the supervisor must be able to watch and
  // cancel autopilot/scheduled ops without tool_search friction (contract
  // pinned by test/tool-filter-supervisor-surface.test.ts). autopilot_*
  // start/stop/status are deferred — tool_search or literal call.
  op_status:   ["main-chat"],
  op_kill:     ["main-chat"],
  op_redirect: ["main-chat"],

  // Self-edit
  self_edit: ["main-chat", "build-intent"],

  // Planning & tasks
  enter_plan_mode: ["main-chat"],
  exit_plan_mode:  ["main-chat"],
  // task tools reach spawned workers too: the open-steps completion gate
  // (canonical-loop) seeds and enforces a step plan on every worker run.
  task_create:     ["main-chat", "spawned-agent"],
  task_update:     ["main-chat", "spawned-agent"],
  task_list:       ["main-chat", "spawned-agent"],
  task_get:        ["main-chat", "spawned-agent"],

  // Protocols — one collapsed tool (action param), see src/protocols/protocol-tool.ts
  protocol: ["main-chat"],

  // MCP administration — agent sets up external MCP servers on request.
  mcp_add_server: ["main-chat"],

  // Mission scheduling: deferred — the keyword router's mission_ prefix rule
  // (social keywords) resurfaces the family; tool_search covers the rest.

  // Agents — canonical delegation surface
  agent_list:   ["main-chat", "build-intent"],
  agent_spawn:  ["main-chat", "build-intent"],
  agent_create: ["main-chat", "build-intent"],

  // Project containers (sibling to agent_* — same eager visibility)
  project_create:    ["main-chat", "build-intent"],
  project_list:      ["main-chat", "build-intent"],
  project_add_agent: ["main-chat", "build-intent"],
  // Project brief — the main agent answers project questions by reading the
  // brief, so it must be eager (not deferred). Spawned agents get both via
  // IDENTITY_TOOLS in tool-search.ts, not here.
  project_brief_read:   ["main-chat", "build-intent"],
  project_brief_update: ["main-chat"],
  agent_status: ["main-chat", "build-intent"],
  // agent_cancel stays eager — same watch-and-cancel contract as op_kill.
  agent_cancel: ["main-chat"],
  agent_output: ["main-chat"],
  agent_kill:   ["build-intent"],

  // Browser
  browser: ["main-chat", "spawned-agent", "operator"],

  // Apps. app_create/app_list are deferred — the keyword router's
  // /\bapp\b|dashboard|tracker/ rule surfaces app_* on the messages that
  // need them (same path as email_*/calendar_*).
  build_app: ["main-chat", "build-intent"],
  // Connector definition — eager wherever build_app is, so the main agent can
  // wire an app's data source. The in-canonical builder gets it directly via
  // BUILDER_AGENT_TOOLS (build-app.ts), not through this map.
  connector_create: ["main-chat", "build-intent"],

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

  // Office documents — one collapsed tool per family (action param).
  // document/presentation are main-chat eager; spreadsheet/pdf surface via
  // the keyword router for main-chat, eagerly for workers.
  document:     ["main-chat", "spawned-agent", "operator"],
  presentation: ["main-chat", "spawned-agent", "operator"],
  spreadsheet:  ["spawned-agent", "operator"],
  pdf:          ["spawned-agent", "operator"],

  // Operator-only specialty tools
  email_send: ["spawned-agent", "operator"],
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
