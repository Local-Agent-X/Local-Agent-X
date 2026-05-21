/**
 * ToolRisk — autonomy risk classification for tool calls.
 *
 * Orthogonal to TOOL_CLASS_MAP in ari-kernel: that map answers "does the
 * kernel need to defend this?". This one answers "if this fires without
 * asking, what does the USER stand to lose?". The profile gate consumes
 * classifyToolRisk(name) and asks profiles.decide() to gate the call.
 *
 * Both maps stay hardcoded with the same key set. The boot-time
 * auditRiskCoverage() throws if any TOOL_CLASS_MAP key is missing here —
 * silent fallback to "shell" would over-restrict safe tools and degrade
 * the profile gate's signal before anyone noticed.
 *
 * Classify by user-visible blast radius, not kernel-defense need. Same
 * file lived previously at src/ari-kernel/tool-class-map.ts as
 * TOOL_AUTONOMY_RISK; moved here so the autonomy gate is the canonical
 * owner (and approval-manager.ts is a thin adapter on top of it).
 */

import { createLogger } from "../logger.js";
import { TOOL_CLASS_MAP } from "../ari-kernel/tool-class-map.js";

const logger = createLogger("autonomy");

export type ToolRisk =
  | "safe"             // read-only local / pure compute / catalog lookup
  | "workspace-write"  // creates or mutates files in workspace/ or LAX state
  | "network-read"     // outbound read-only (GET fetch, search, scrape)
  | "network-write"    // outbound state-changing (POST/PUT/DELETE, multi-method clients)
  | "shell"            // subprocess spawn / arbitrary command execution
  | "destructive"      // irreversible delete / overwrite / cancel / uninstall
  | "money"            // bills a real-world account (payments, paid APIs metered to user)
  | "external-comms"   // sends a message a third party will see (email, SMS, calendar invite)
  | "secrets";         // touches the credential vault — read, write, or fill-from

export const TOOL_RISK: Record<string, ToolRisk> = {
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
  // sql_query is workspace-write today — scoped read-only sandbox is a
  // follow-up. Flag here so we don't lose context when refining the tier.
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

const _seenUnclassified = new Set<string>();

// Fail-safe: unmapped tools fall back to "shell" — most-restrictive
// non-destructive tier short of a real-world communication / money move.
// The boot-time audit catches drift before any user-visible call.
export function classifyToolRisk(toolName: string): ToolRisk {
  const risk = TOOL_RISK[toolName];
  if (risk === undefined) {
    if (!_seenUnclassified.has(toolName)) {
      _seenUnclassified.add(toolName);
      logger.warn(`[autonomy] ${toolName} not in TOOL_RISK — defaulting to "shell" (fail-safe). Add to TOOL_RISK in src/autonomy/risk.ts.`);
    }
    return "shell";
  }
  return risk;
}

// Twin-map invariant: every TOOL_CLASS_MAP key must have a TOOL_RISK
// entry. Throws on divergence — there's no recovery path; a missing
// entry silently degrades to "shell" and the profile gate over-restricts.
export function auditRiskCoverage(): void {
  const missing: string[] = [];
  for (const toolName of Object.keys(TOOL_CLASS_MAP)) {
    if (TOOL_RISK[toolName] === undefined) missing.push(toolName);
  }
  if (missing.length === 0) {
    logger.info(`  \x1b[36mℹ\x1b[0m All ${Object.keys(TOOL_CLASS_MAP).length} TOOL_CLASS_MAP entries have a TOOL_RISK\n`);
    return;
  }
  const detail = missing.map(n => `    - ${n}`).join("\n");
  const msg = `TOOL_RISK is missing ${missing.length} entries that exist in TOOL_CLASS_MAP:\n${detail}\nAdd each to TOOL_RISK in src/autonomy/risk.ts.`;
  logger.error(`  \x1b[31m✖\x1b[0m ${msg}\n`);
  throw new Error(`[autonomy] auditRiskCoverage: ${msg}`);
}
