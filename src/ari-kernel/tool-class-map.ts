// Tool → kernel-class mapping. THE single source of truth for which tools
// route through firewall.execute and under what class. Two semantic kinds:
//
//   - GATED CLASS (file / http / shell / database / retrieval / secret-vault)
//     Kernel evaluates the call at the dispatch layer (Layer -1 in the
//     enforce-policy phase) — taint analysis, capability check, audit log.
//   - "internal"
//     Tool runs entirely inside LAX state (no raw I/O, or raw I/O that
//     already routes through a kernel-direct path like arikernel-bridge).
//     Dispatch skips the kernel for these. Adding a tool here is a
//     deliberate statement that it does not need (or already does) kernel
//     evaluation.
//
// Unmapped tools fail-closed — shouldGateInKernel returns true so the
// kernel sees them with no class match and blocks. The boot coverage
// audit (auditKernelCoverage) surfaces the gap up front; this dedup set
// throttles the runtime warning so a single misclassified tool doesn't
// flood the log.

import { createLogger } from "../logger.js";

const logger = createLogger("ari-kernel");

export const TOOL_CLASS_MAP: Record<string, string> = {
  // ── Gated I/O — kernel runs at dispatch ──
  bash: "shell",
  read: "file",
  write: "file",
  edit: "file",
  browser: "http",
  http_request: "http",
  web_fetch: "http",
  web_search: "http",
  memory_search: "retrieval",
  memory_save: "database",
  browser_capture_to_secret: "secret-vault",
  browser_fill_from_secret: "secret-vault",
  clipboard_write_from_secret: "secret-vault",

  // ── Internal — kernel skipped at dispatch ──
  // ari_*: arikernel-bridge wraps kernel executors directly; the kernel
  // runs INSIDE the bridge for these. Dispatch-layer evaluation would be
  // double-routing with a fake class/action.
  ari_file: "internal",
  ari_http: "internal",
  ari_shell: "internal",
  ari_database: "internal",
  ari_retrieval: "internal",
  ari_sqlite_database: "internal",
  // self_edit runs sandboxed code repair through its own subprocess with
  // its own build/server-bind/agent-smoke gates before merge — kernel
  // gating here would block legitimate repair flows.
  self_edit: "internal",
  // Agent / swarm / mission orchestration — pure LAX state transitions.
  agent_spawn: "internal",
  agent_redirect: "internal",
  agent_pause: "internal",
  agent_resume: "internal",
  agent_cancel: "internal",
  agent_status: "internal",
  agent_output: "internal",
  agent_message: "internal",
  delegate: "internal",
  swarm_create: "internal",
  swarm_status: "internal",
  swarm_cancel: "internal",
  swarm_list_roles: "internal",
  swarm_result: "internal",
  mission_list: "internal",
  mission_get: "internal",
  mission_save_preference: "internal",
  mission_format_caption: "internal",
  mission_build: "internal",
  mission_edit: "internal",
  mission_delete: "internal",
  mission_schedule_create: "internal",
  mission_schedule_delete: "internal",
  mission_chain: "internal",
  mission_variables_set: "internal",
  mission_variables_get: "internal",
  mission_schedule_list: "internal",
  mission_schedule_update: "internal",
  mission_schedule_toggle: "internal",
  mission_schedule_reports: "internal",
  playbook_list: "internal",
  playbook_get: "internal",
  // Protocols — LAX-internal catalog operations. Mirrors mission_*:
  // write-path tools target fixed structured paths under
  // workspace/protocols/, agent supplies a NAME not a path.
  protocol_list: "internal",
  protocol_get: "internal",
  protocol_search: "internal",
  protocol_save_preference: "internal",
  protocol_format_caption: "internal",
  protocol_dry_run: "internal",
  protocol_create: "internal",
  protocol_edit: "internal",
  protocol_delete: "internal",
  protocol_unarchive: "internal",
  protocol_pin: "internal",
  protocol_list_archived: "internal",
  protocol_stats: "internal",
  protocol_prune: "internal",
  protocol_archive_bulk: "internal",
  protocol_curate: "internal",
  protocol_curator_status: "internal",
  protocol_chain_create: "internal",
  protocol_chain_start: "internal",
  protocol_chain_advance: "internal",
  protocol_rollback_init: "internal",
  protocol_rollback_snapshot: "internal",
  protocol_rollback_undo: "internal",
  protocol_rollback_history: "internal",
  protocol_progress_start: "internal",
  protocol_progress_update: "internal",
  protocol_progress_get: "internal",
  protocol_templates_list: "internal",
  protocol_from_template: "internal",
  protocol_var_set: "internal",
  protocol_var_get: "internal",
  protocol_var_delete: "internal",
  protocol_var_list: "internal",
  protocol_var_interpolate: "internal",
  // Media / vision — LAX-internal acquisition + cached files.
  generate_image: "internal",
  generate_video: "internal",
  camera_capture: "internal",
  screen_capture: "internal",
  ocr: "internal",

  // ── Coverage backfill 2026-05-20 ──
  // Boot audit caught 120 unmapped tools after the fail-closed flip.
  // Classification rules of thumb:
  //   - Raw file ops (agent-supplied path, arbitrary workspace target) → file
  //   - External egress (Gmail/Calendar APIs, marketplace, site scrape) → http
  //   - Subprocess spawning → shell
  //   - SQL → database
  //   - Vector/session search → retrieval
  //   - Everything else (orchestration, LAX state, workspace structured
  //     documents bounded by SecurityLayer, vault metadata) → internal

  // file — raw fs ops the agent points at any workspace path
  glob: "file",
  grep: "file",
  delete_file: "file",
  view_image: "file",

  // http — external API calls / web fetches
  calendar_check_availability: "http",
  calendar_create_event: "http",
  calendar_list_events: "http",
  email_draft: "http",
  email_read: "http",
  email_search: "http",
  email_send: "http",
  email_setup: "http",
  marketplace_search: "http",
  marketplace_install: "http",
  marketplace_list: "http",
  extract_site_assets: "http",
  youtube_analyze: "http",

  // shell — spawns child processes
  process_start: "shell",
  process_status: "shell",
  process_kill: "shell",
  process_list: "shell",
  install_software: "shell",

  // database — SQL execution
  sql_query: "database",
  sql_explain: "database",
  sql_schema: "database",

  // retrieval — vector/keyword search over session corpora
  search_past_sessions: "retrieval",

  // internal — orchestration, LAX state, vault metadata, structured docs.
  // memory_*: only memory_search (retrieval) + memory_save (database) need
  // kernel gating, both mapped above. Rest are pure state transitions.
  memory_consolidate: "internal",
  memory_discover: "internal",
  memory_dream: "internal",
  memory_forget: "internal",
  memory_forget_imports: "internal",
  memory_get: "internal",
  memory_ingest: "internal",
  memory_recall: "internal",
  memory_reflect: "internal",
  memory_reindex: "internal",
  memory_update_profile: "internal",
  // Secrets: vault writes/reads use the secret-vault class via the
  // browser_/clipboard_*_secret tools (already mapped). Tools below are
  // metadata-only (UI prompt for value; list/meta return names not values).
  request_secret: "internal",
  request_secrets: "internal",
  list_secrets: "internal",
  get_secret_meta: "internal",
  // Agent orchestration — LAX state transitions, no raw I/O sink.
  agent_list: "internal",
  agent_create: "internal",
  agent_team_list: "internal",
  agent_wakeup: "internal",
  agent_whoami: "internal",
  agency_create: "internal",
  agency_status: "internal",
  agency_cancel: "internal",
  agency_list_roles: "internal",
  agency_result: "internal",
  // In-platform app builder — operates on workspace/apps/ via structured API.
  app_create: "internal",
  app_update: "internal",
  app_read: "internal",
  app_action: "internal",
  app_query: "internal",
  app_list: "internal",
  app_delete: "internal",
  app_permissions: "internal",
  // Sidebar pin/unpin — UI state only.
  sidebar_pin: "internal",
  sidebar_unpin: "internal",
  // Issues / tasks — agent task management in LAX state.
  issue_create: "internal",
  issue_list: "internal",
  issue_update: "internal",
  issue_checkout: "internal",
  issue_release: "internal",
  issue_search: "internal",
  // Operations — long-horizon goal orchestrator, writes to workspace/operations/.
  operation_start: "internal",
  operation_list: "internal",
  operation_status: "internal",
  operation_next: "internal",
  operation_advance: "internal",
  // Worker-pool ops — submit/wait/status across subprocess boundary. The
  // worker's actual I/O work gates at its own dispatch layer.
  op_submit: "internal",
  op_submit_async: "internal",
  op_wait: "internal",
  op_status: "internal",
  op_kill: "internal",
  op_redirect: "internal",
  // Autopilot — bounded autonomous work in isolated worktree.
  autopilot_start: "internal",
  autopilot_status: "internal",
  autopilot_stop: "internal",
  // App-build pipeline — multi-step orchestrator, file/shell work happens
  // inside spawned workers which gate at their own dispatch layer.
  build_app: "internal",
  create_page: "internal",
  start_app_build: "internal",
  finalize_app_build: "internal",
  primal_build_resume: "internal",
  primal_build_status: "internal",
  primal_run_build_plan: "internal",
  // Voice + session + config — UI/state surfaces.
  voice_visual: "internal",
  session_status: "internal",
  setting: "internal",
  config_get: "internal",
  config_set: "internal",
  // Clipboard read/write of plain text — the secret-vault variant is gated
  // separately. Raw clipboard is OS-managed; no agent path/URL sink.
  clipboard_read: "internal",
  clipboard_write: "internal",
  // Tasks / diagnostics / planning — LAX state only.
  task_create: "internal",
  task_get: "internal",
  task_list: "internal",
  task_update: "internal",
  doctor: "internal",
  usage_report: "internal",
  tool_search: "internal",
  list_monitors: "internal",
  enter_plan_mode: "internal",
  exit_plan_mode: "internal",
  // Structured workspace documents — agent supplies a path, but SecurityLayer
  // path-bounds the call to workspace/ and the tools read/write canonical
  // formats via dedicated parsers. Raw read/write/edit of arbitrary paths
  // remains gated as `file`.
  spreadsheet_read: "internal",
  spreadsheet_write: "internal",
  spreadsheet_edit: "internal",
  spreadsheet_query: "internal",
  document_create: "internal",
  document_edit: "internal",
  document_read: "internal",
  document_template: "internal",
  presentation_create: "internal",
  presentation_add_slide: "internal",
  presentation_from_outline: "internal",
  pdf_create: "internal",
  pdf_read: "internal",
  pdf_extract_tables: "internal",
  pdf_merge: "internal",
};

export const GATED_CLASSES: ReadonlySet<string> = new Set([
  "file", "http", "shell", "database", "retrieval", "secret-vault",
]);

// ─────────────────────────────────────────────────────────────────────
// AUTONOMY RISK — orthogonal to kernel-class above.
//
// TOOL_CLASS_MAP answers "does the kernel need to see this?". Autonomy
// risk answers "if this fires without asking, what does the USER stand
// to lose?". The upcoming tiered-autonomy gate (Prompt 5) consumes this
// to decide whether the tool runs free, prompts, or is denied under a
// given profile.
//
// Both maps stay hardcoded. A prior auto-registration experiment moved
// the source of truth into the tool definitions themselves and lost the
// boot-time coverage guarantee — reverted. Add new tools to BOTH maps.
export type AutonomyRisk =
  | "safe"             // read-only local / pure compute / catalog lookup
  | "workspace-write"  // creates or mutates files in workspace/ or LAX state
  | "network-read"     // outbound read-only (GET fetch, search, scrape)
  | "network-write"    // outbound state-changing (POST/PUT/DELETE, multi-method clients)
  | "shell"            // subprocess spawn / arbitrary command execution
  | "destructive"      // irreversible delete / overwrite / cancel / uninstall
  | "money"            // bills a real-world account (payments, paid APIs metered to user)
  | "external-comms"   // sends a message a third party will see (email, SMS, calendar invite)
  | "secrets";         // touches the credential vault — read, write, or fill-from

// Classify by user-visible blast radius, not by kernel-defense need.
// Same key set as TOOL_CLASS_MAP — enforced by auditAutonomyCoverage.
export const TOOL_AUTONOMY_RISK: Record<string, AutonomyRisk> = {
  // ── Shell / subprocess ──
  bash: "shell",
  ari_shell: "shell",
  process_start: "shell",
  process_status: "safe",
  process_kill: "destructive",
  process_list: "safe",
  install_software: "destructive",

  // ── Raw filesystem ──
  read: "safe",
  write: "workspace-write",
  edit: "workspace-write",
  delete_file: "destructive",
  glob: "safe",
  grep: "safe",
  view_image: "safe",
  ari_file: "workspace-write",

  // ── Network ──
  browser: "network-read",
  browser_capture_to_secret: "secrets",
  browser_fill_from_secret: "secrets",
  http_request: "network-write",
  ari_http: "network-write",
  web_fetch: "network-read",
  web_search: "safe",
  youtube_analyze: "network-read",
  extract_site_assets: "network-read",

  // ── External services (Gmail / Calendar / Marketplace) ──
  email_read: "network-read",
  email_search: "network-read",
  email_draft: "workspace-write",
  email_setup: "workspace-write",
  email_send: "external-comms",
  calendar_check_availability: "network-read",
  calendar_list_events: "network-read",
  calendar_create_event: "external-comms",
  marketplace_search: "network-read",
  marketplace_list: "network-read",
  marketplace_install: "destructive",

  // ── Database (workspace SQLite + structured queries) ──
  sql_query: "workspace-write",
  sql_explain: "safe",
  sql_schema: "safe",
  ari_database: "workspace-write",
  ari_sqlite_database: "workspace-write",

  // ── Retrieval / search ──
  ari_retrieval: "safe",
  search_past_sessions: "safe",
  memory_search: "safe",

  // ── Secrets vault ──
  clipboard_write_from_secret: "secrets",
  request_secret: "secrets",
  request_secrets: "secrets",
  list_secrets: "secrets",
  get_secret_meta: "secrets",

  // ── Memory ──
  memory_save: "workspace-write",
  memory_consolidate: "workspace-write",
  memory_discover: "safe",
  memory_dream: "workspace-write",
  memory_forget: "destructive",
  memory_forget_imports: "destructive",
  memory_get: "safe",
  memory_ingest: "workspace-write",
  memory_recall: "safe",
  memory_reflect: "workspace-write",
  memory_reindex: "workspace-write",
  memory_update_profile: "workspace-write",

  // ── Self-edit — sandboxed, but the merge mutates running source ──
  self_edit: "destructive",

  // ── Agent / swarm / delegation orchestration ──
  agent_spawn: "workspace-write",
  agent_create: "workspace-write",
  agent_redirect: "workspace-write",
  agent_pause: "workspace-write",
  agent_resume: "workspace-write",
  agent_cancel: "destructive",
  agent_status: "safe",
  agent_output: "safe",
  agent_message: "workspace-write",
  agent_list: "safe",
  agent_team_list: "safe",
  agent_wakeup: "workspace-write",
  agent_whoami: "safe",
  delegate: "workspace-write",
  swarm_create: "workspace-write",
  swarm_status: "safe",
  swarm_cancel: "destructive",
  swarm_list_roles: "safe",
  swarm_result: "safe",
  agency_create: "workspace-write",
  agency_status: "safe",
  agency_cancel: "destructive",
  agency_list_roles: "safe",
  agency_result: "safe",

  // ── Missions / playbooks ──
  mission_list: "safe",
  mission_get: "safe",
  mission_save_preference: "workspace-write",
  mission_format_caption: "safe",
  mission_build: "workspace-write",
  mission_edit: "workspace-write",
  mission_delete: "destructive",
  mission_schedule_create: "workspace-write",
  mission_schedule_delete: "destructive",
  mission_chain: "workspace-write",
  mission_variables_set: "workspace-write",
  mission_variables_get: "safe",
  mission_schedule_list: "safe",
  mission_schedule_update: "workspace-write",
  mission_schedule_toggle: "workspace-write",
  mission_schedule_reports: "safe",
  playbook_list: "safe",
  playbook_get: "safe",

  // ── Protocols ──
  protocol_list: "safe",
  protocol_get: "safe",
  protocol_search: "safe",
  protocol_save_preference: "workspace-write",
  protocol_format_caption: "safe",
  protocol_dry_run: "safe",
  protocol_create: "workspace-write",
  protocol_edit: "workspace-write",
  protocol_delete: "destructive",
  protocol_unarchive: "workspace-write",
  protocol_pin: "workspace-write",
  protocol_list_archived: "safe",
  protocol_stats: "safe",
  protocol_prune: "destructive",
  protocol_archive_bulk: "destructive",
  protocol_curate: "workspace-write",
  protocol_curator_status: "safe",
  protocol_chain_create: "workspace-write",
  protocol_chain_start: "workspace-write",
  protocol_chain_advance: "workspace-write",
  protocol_rollback_init: "workspace-write",
  protocol_rollback_snapshot: "workspace-write",
  protocol_rollback_undo: "destructive",
  protocol_rollback_history: "safe",
  protocol_progress_start: "workspace-write",
  protocol_progress_update: "workspace-write",
  protocol_progress_get: "safe",
  protocol_templates_list: "safe",
  protocol_from_template: "workspace-write",
  protocol_var_set: "workspace-write",
  protocol_var_get: "safe",
  protocol_var_delete: "destructive",
  protocol_var_list: "safe",
  protocol_var_interpolate: "safe",

  // ── Media generation / capture ──
  generate_image: "workspace-write",
  generate_video: "workspace-write",
  camera_capture: "workspace-write",
  screen_capture: "workspace-write",
  ocr: "workspace-write",

  // ── Apps (workspace/apps/) ──
  app_create: "workspace-write",
  app_update: "workspace-write",
  app_read: "safe",
  app_action: "workspace-write",
  app_query: "safe",
  app_list: "safe",
  app_delete: "destructive",
  app_permissions: "safe",

  // ── Issues / tasks ──
  issue_create: "workspace-write",
  issue_list: "safe",
  issue_update: "workspace-write",
  issue_checkout: "workspace-write",
  issue_release: "workspace-write",
  issue_search: "safe",
  task_create: "workspace-write",
  task_get: "safe",
  task_list: "safe",
  task_update: "workspace-write",

  // ── Operations / worker-pool ──
  operation_start: "workspace-write",
  operation_list: "safe",
  operation_status: "safe",
  operation_next: "safe",
  operation_advance: "workspace-write",
  op_submit: "workspace-write",
  op_submit_async: "workspace-write",
  op_wait: "safe",
  op_status: "safe",
  op_kill: "destructive",
  op_redirect: "workspace-write",

  // ── Autopilot ──
  autopilot_start: "workspace-write",
  autopilot_status: "safe",
  autopilot_stop: "destructive",

  // ── App-build pipeline ──
  build_app: "workspace-write",
  create_page: "workspace-write",
  start_app_build: "workspace-write",
  finalize_app_build: "workspace-write",
  primal_build_resume: "workspace-write",
  primal_build_status: "safe",
  primal_run_build_plan: "workspace-write",

  // ── UI / state / config ──
  sidebar_pin: "workspace-write",
  sidebar_unpin: "workspace-write",
  voice_visual: "safe",
  session_status: "safe",
  setting: "workspace-write",
  config_get: "safe",
  config_set: "workspace-write",
  clipboard_read: "safe",
  clipboard_write: "workspace-write",

  // ── Diagnostics / planning ──
  doctor: "safe",
  usage_report: "safe",
  tool_search: "safe",
  list_monitors: "safe",
  enter_plan_mode: "safe",
  exit_plan_mode: "safe",

  // ── Structured workspace documents (bounded by SecurityLayer) ──
  spreadsheet_read: "safe",
  spreadsheet_write: "workspace-write",
  spreadsheet_edit: "workspace-write",
  spreadsheet_query: "safe",
  document_create: "workspace-write",
  document_edit: "workspace-write",
  document_read: "safe",
  document_template: "safe",
  presentation_create: "workspace-write",
  presentation_add_slide: "workspace-write",
  presentation_from_outline: "workspace-write",
  pdf_create: "workspace-write",
  pdf_read: "safe",
  pdf_extract_tables: "safe",
  pdf_merge: "workspace-write",
};

const _seenUnclassifiedAutonomy = new Set<string>();

// Returns the autonomy risk for a tool. Unknown tools fall back to "shell"
// — the most-restrictive non-destructive tier short of a real-world
// communication or money move. Fail-safe means: a tool we forgot to
// classify gets the same treatment as raw subprocess execution, so the
// profile gate will demand explicit confirmation rather than silently
// permitting it. The boot-time auditAutonomyCoverage catches divergence
// between TOOL_CLASS_MAP and this map before any user-visible call.
export function classifyAutonomy(toolName: string): AutonomyRisk {
  const risk = TOOL_AUTONOMY_RISK[toolName];
  if (risk === undefined) {
    if (!_seenUnclassifiedAutonomy.has(toolName)) {
      _seenUnclassifiedAutonomy.add(toolName);
      logger.warn(`[ari] ${toolName} not in TOOL_AUTONOMY_RISK — defaulting to "shell" (fail-safe). Add to TOOL_AUTONOMY_RISK in src/ari-kernel/tool-class-map.ts.`);
    }
    return "shell";
  }
  return risk;
}

const _seenUnmappedTools = new Set<string>();

// Returns true for:
//   - tools mapped to a gated I/O class (file/http/shell/database/retrieval/secret-vault)
//   - tools NOT in the map (fail-closed: missing classification = treat as risky)
// Returns false ONLY for tools explicitly classified "internal".
//
// Why fail-closed on unmapped: a new tool added without a TOOL_CLASS_MAP
// entry is, by definition, an unaudited I/O surface. Defaulting to "skip
// the kernel" means a prompt-injection-controlled parameter could reach an
// I/O sink with the deepest defense layer disabled. Forcing-function for
// coverage.
export function shouldGateInKernel(toolName: string): boolean {
  const cls = TOOL_CLASS_MAP[toolName];
  if (cls === undefined) {
    if (!_seenUnmappedTools.has(toolName)) {
      _seenUnmappedTools.add(toolName);
      logger.warn(`[ari] ${toolName} not in TOOL_CLASS_MAP — defaulting to BLOCK (fail-closed). Add to TOOL_CLASS_MAP in src/ari-kernel/tool-class-map.ts to classify.`);
    }
    return true;
  }
  return GATED_CLASSES.has(cls);
}

// Should this tool flow through the kernel's audit-only observation path?
// Returns true ONLY for "internal" class — orchestration, LAX state
// transitions, structured workspace docs. These don't have an agent-
// controlled I/O sink the kernel can defend, so they SKIP the enforcement
// pipeline. But they still pass through ariObserve so the operator gets a
// uniform "[ari] every tool call" audit trail.
export function shouldObserveInKernel(toolName: string): boolean {
  return TOOL_CLASS_MAP[toolName] === "internal";
}
