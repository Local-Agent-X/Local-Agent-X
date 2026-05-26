// Single source of truth for tool taxonomy. Each tool gets ONE entry
// with two orthogonal classifications:
//
//   kernel:  what defense pipeline runs at dispatch? (ari-kernel/evaluate.ts)
//   risk:    what does the user lose if this fires without approval?
//            (consumed by autonomy gate + approval-manager)
//
// Why one record instead of two parallel maps: previously TOOL_CLASS_MAP
// (kernel) and TOOL_RISK (autonomy) lived in separate files. Every new
// tool required edits in lockstep — and a runtime "refuse to boot" audit
// (auditRiskCoverage) was the safety net that caught divergence. The
// audit fired late, threw synchronously during server startup, and the
// fix required a code edit + restart. Colocating the data turns the
// two-file invariant into a single-record requirement that TypeScript
// enforces at edit time.
//
// The two derived maps (TOOL_CLASS_MAP, TOOL_RISK) are exported from
// their original modules for unchanged downstream consumers.

export type KernelClass =
  | "file"
  | "http"
  | "shell"
  | "database"
  | "retrieval"
  | "secret-vault"
  | "internal";

export type ToolRisk =
  | "safe"             // read-only local / pure compute / catalog lookup
  | "workspace-write"  // creates or mutates files in workspace/ or LAX state
  | "network-read"     // outbound read-only (GET fetch, search, scrape)
  | "network-write"    // outbound state-changing (POST/PUT/DELETE)
  | "shell"            // subprocess spawn / arbitrary command execution
  | "destructive"      // irreversible delete / overwrite / cancel / uninstall
  | "money"            // bills a real-world account (payments, paid APIs)
  | "external-comms"   // sends a message a third party will see
  | "secrets";         // touches the credential vault — read, write, or fill-from

export interface ToolEntry {
  kernel: KernelClass;
  risk: ToolRisk;
}

// Kernel classes that gate at dispatch (taint analysis, capability check,
// audit log). "internal" runs entirely inside LAX state — dispatch skips
// the kernel. See ari-kernel/tool-class-map.ts:shouldGateInKernel.
export const GATED_KERNEL_CLASSES: ReadonlySet<KernelClass> = new Set<KernelClass>([
  "file", "http", "shell", "database", "retrieval", "secret-vault",
]);

export const TOOLS: Record<string, ToolEntry> = {
  // ── Shell / subprocess ──
  bash:             { kernel: "shell",    risk: "shell" },
  ari_shell:        { kernel: "internal", risk: "shell" },
  process_start:    { kernel: "shell",    risk: "shell" },
  process_status:   { kernel: "shell",    risk: "safe" },
  process_kill:     { kernel: "shell",    risk: "destructive" },
  process_list:     { kernel: "shell",    risk: "safe" },
  install_software: { kernel: "shell",    risk: "destructive" },

  // ── Raw filesystem ──
  read:        { kernel: "file",     risk: "safe" },
  write:       { kernel: "file",     risk: "workspace-write" },
  edit:        { kernel: "file",     risk: "workspace-write" },
  delete_file: { kernel: "file",     risk: "destructive" },
  glob:        { kernel: "file",     risk: "safe" },
  grep:        { kernel: "file",     risk: "safe" },
  view_image:  { kernel: "file",     risk: "safe" },
  ari_file:    { kernel: "internal", risk: "workspace-write" },

  // ── Network ──
  browser:                   { kernel: "http",         risk: "network-read" },
  browser_capture_to_secret: { kernel: "secret-vault", risk: "secrets" },
  browser_fill_from_secret:  { kernel: "secret-vault", risk: "secrets" },
  http_request:              { kernel: "http",         risk: "network-write" },
  ari_http:                  { kernel: "internal",     risk: "network-write" },
  web_fetch:                 { kernel: "http",         risk: "network-read" },
  web_search:                { kernel: "http",         risk: "safe" },
  youtube_analyze:           { kernel: "http",         risk: "network-read" },
  extract_site_assets:       { kernel: "http",         risk: "network-read" },

  // ── External services (Gmail / Calendar / Marketplace) ──
  email_read:                  { kernel: "http", risk: "network-read" },
  email_search:                { kernel: "http", risk: "network-read" },
  email_draft:                 { kernel: "http", risk: "workspace-write" },
  email_setup:                 { kernel: "http", risk: "workspace-write" },
  email_send:                  { kernel: "http", risk: "external-comms" },
  calendar_check_availability: { kernel: "http", risk: "network-read" },
  calendar_list_events:        { kernel: "http", risk: "network-read" },
  calendar_create_event:       { kernel: "http", risk: "external-comms" },
  marketplace_search:          { kernel: "http", risk: "network-read" },
  marketplace_list:            { kernel: "http", risk: "network-read" },
  marketplace_install:         { kernel: "http", risk: "destructive" },

  // ── Database ──
  // sql_query is workspace-write today — scoped read-only sandbox is a
  // follow-up. Flag here so we don't lose context when refining the tier.
  sql_query:           { kernel: "database", risk: "workspace-write" },
  sql_explain:         { kernel: "database", risk: "safe" },
  sql_schema:          { kernel: "database", risk: "safe" },
  ari_database:        { kernel: "internal", risk: "workspace-write" },
  ari_sqlite_database: { kernel: "internal", risk: "workspace-write" },

  // ── Retrieval / search ──
  ari_retrieval:       { kernel: "internal",  risk: "safe" },
  search_past_sessions:{ kernel: "retrieval", risk: "safe" },
  memory_search:       { kernel: "retrieval", risk: "safe" },

  // ── Secrets vault ──
  clipboard_write_from_secret: { kernel: "secret-vault", risk: "secrets" },
  request_secret:              { kernel: "internal",     risk: "secrets" },
  request_secrets:             { kernel: "internal",     risk: "secrets" },
  list_secrets:                { kernel: "internal",     risk: "secrets" },
  get_secret_meta:             { kernel: "internal",     risk: "secrets" },

  // ── Memory ──
  memory_save:            { kernel: "database", risk: "workspace-write" },
  memory_consolidate:     { kernel: "internal", risk: "workspace-write" },
  memory_discover:        { kernel: "internal", risk: "safe" },
  memory_dream:           { kernel: "internal", risk: "workspace-write" },
  memory_forget:          { kernel: "internal", risk: "destructive" },
  memory_forget_imports:  { kernel: "internal", risk: "destructive" },
  memory_get:             { kernel: "internal", risk: "safe" },
  memory_ingest:          { kernel: "internal", risk: "workspace-write" },
  memory_recall:          { kernel: "internal", risk: "safe" },
  memory_reflect:         { kernel: "internal", risk: "workspace-write" },
  memory_reindex:         { kernel: "internal", risk: "workspace-write" },
  memory_stats:           { kernel: "internal", risk: "safe" },
  memory_set_user_field:  { kernel: "internal", risk: "workspace-write" },
  memory_update_profile:  { kernel: "internal", risk: "workspace-write" },
  // Single-fact Facts DB API (replaces MIND.md as the durable knowledge layer).
  // Routed via existing memory_* tool-policy allow rule; classified internal
  // because they only mutate the Facts DB (no raw I/O, no agent-controlled
  // path/URL/shell argument the kernel needs to gate).
  remember:               { kernel: "internal", risk: "workspace-write" },
  update_fact:            { kernel: "internal", risk: "workspace-write" },
  forget:                 { kernel: "internal", risk: "destructive" },

  // ── Self-edit — sandboxed, but the merge mutates running source ──
  self_edit: { kernel: "internal", risk: "destructive" },

  // ── Agent / swarm / delegation orchestration ──
  agent_spawn:     { kernel: "internal", risk: "workspace-write" },
  agent_create:    { kernel: "internal", risk: "workspace-write" },
  agent_redirect:  { kernel: "internal", risk: "workspace-write" },
  agent_pause:     { kernel: "internal", risk: "workspace-write" },
  agent_resume:    { kernel: "internal", risk: "workspace-write" },
  agent_cancel:    { kernel: "internal", risk: "destructive" },
  agent_status:    { kernel: "internal", risk: "safe" },
  agent_output:    { kernel: "internal", risk: "safe" },
  agent_message:   { kernel: "internal", risk: "workspace-write" },
  agent_escalate:  { kernel: "internal", risk: "workspace-write" },
  agent_list:      { kernel: "internal", risk: "safe" },
  agent_team_list: { kernel: "internal", risk: "safe" },
  agent_wakeup:    { kernel: "internal", risk: "workspace-write" },
  agent_whoami:    { kernel: "internal", risk: "safe" },
  delegate:        { kernel: "internal", risk: "workspace-write" },
  swarm_create:    { kernel: "internal", risk: "workspace-write" },
  swarm_status:    { kernel: "internal", risk: "safe" },
  swarm_cancel:    { kernel: "internal", risk: "destructive" },
  swarm_list_roles:{ kernel: "internal", risk: "safe" },
  swarm_result:    { kernel: "internal", risk: "safe" },
  agency_create:   { kernel: "internal", risk: "workspace-write" },
  agency_status:   { kernel: "internal", risk: "safe" },
  agency_cancel:   { kernel: "internal", risk: "destructive" },
  agency_list_roles:{ kernel: "internal", risk: "safe" },
  agency_result:   { kernel: "internal", risk: "safe" },

  // ── Missions / playbooks ──
  mission_list:             { kernel: "internal", risk: "safe" },
  mission_get:              { kernel: "internal", risk: "safe" },
  mission_save_preference:  { kernel: "internal", risk: "workspace-write" },
  mission_format_caption:   { kernel: "internal", risk: "safe" },
  mission_build:            { kernel: "internal", risk: "workspace-write" },
  mission_edit:             { kernel: "internal", risk: "workspace-write" },
  mission_delete:           { kernel: "internal", risk: "destructive" },
  mission_schedule_create:  { kernel: "internal", risk: "workspace-write" },
  mission_schedule_delete:  { kernel: "internal", risk: "destructive" },
  mission_chain:            { kernel: "internal", risk: "workspace-write" },
  mission_variables_set:    { kernel: "internal", risk: "workspace-write" },
  mission_variables_get:    { kernel: "internal", risk: "safe" },
  mission_schedule_list:    { kernel: "internal", risk: "safe" },
  mission_schedule_update:  { kernel: "internal", risk: "workspace-write" },
  mission_schedule_toggle:  { kernel: "internal", risk: "workspace-write" },
  mission_schedule_reports: { kernel: "internal", risk: "safe" },
  playbook_list:            { kernel: "internal", risk: "safe" },
  playbook_get:             { kernel: "internal", risk: "safe" },

  // ── Protocols ──
  protocol_list:             { kernel: "internal", risk: "safe" },
  protocol_get:              { kernel: "internal", risk: "safe" },
  protocol_search:           { kernel: "internal", risk: "safe" },
  protocol_save_preference:  { kernel: "internal", risk: "workspace-write" },
  protocol_format_caption:   { kernel: "internal", risk: "safe" },
  protocol_dry_run:          { kernel: "internal", risk: "safe" },
  protocol_create:           { kernel: "internal", risk: "workspace-write" },
  protocol_edit:             { kernel: "internal", risk: "workspace-write" },
  protocol_delete:           { kernel: "internal", risk: "destructive" },
  protocol_unarchive:        { kernel: "internal", risk: "workspace-write" },
  protocol_pin:              { kernel: "internal", risk: "workspace-write" },
  protocol_list_archived:    { kernel: "internal", risk: "safe" },
  protocol_stats:            { kernel: "internal", risk: "safe" },
  protocol_prune:            { kernel: "internal", risk: "destructive" },
  protocol_archive_bulk:     { kernel: "internal", risk: "destructive" },
  protocol_curate:           { kernel: "internal", risk: "workspace-write" },
  protocol_curator_status:   { kernel: "internal", risk: "safe" },
  protocol_chain_create:     { kernel: "internal", risk: "workspace-write" },
  protocol_chain_start:      { kernel: "internal", risk: "workspace-write" },
  protocol_chain_advance:    { kernel: "internal", risk: "workspace-write" },
  protocol_rollback_init:    { kernel: "internal", risk: "workspace-write" },
  protocol_rollback_snapshot:{ kernel: "internal", risk: "workspace-write" },
  protocol_rollback_undo:    { kernel: "internal", risk: "destructive" },
  protocol_rollback_history: { kernel: "internal", risk: "safe" },
  protocol_progress_start:   { kernel: "internal", risk: "workspace-write" },
  protocol_progress_update:  { kernel: "internal", risk: "workspace-write" },
  protocol_progress_get:     { kernel: "internal", risk: "safe" },
  protocol_templates_list:   { kernel: "internal", risk: "safe" },
  protocol_from_template:    { kernel: "internal", risk: "workspace-write" },
  protocol_var_set:          { kernel: "internal", risk: "workspace-write" },
  protocol_var_get:          { kernel: "internal", risk: "safe" },
  protocol_var_delete:       { kernel: "internal", risk: "destructive" },
  protocol_var_list:         { kernel: "internal", risk: "safe" },
  protocol_var_interpolate:  { kernel: "internal", risk: "safe" },

  // ── Media generation / capture ──
  generate_image: { kernel: "internal", risk: "workspace-write" },
  generate_video: { kernel: "internal", risk: "workspace-write" },
  camera_capture: { kernel: "internal", risk: "workspace-write" },
  screen_capture: { kernel: "internal", risk: "workspace-write" },
  ocr:            { kernel: "internal", risk: "workspace-write" },

  // ── Apps (workspace/apps/) ──
  app_create:      { kernel: "internal", risk: "workspace-write" },
  app_update:      { kernel: "internal", risk: "workspace-write" },
  app_read:        { kernel: "internal", risk: "safe" },
  app_action:      { kernel: "internal", risk: "workspace-write" },
  app_query:       { kernel: "internal", risk: "safe" },
  app_list:        { kernel: "internal", risk: "safe" },
  app_delete:      { kernel: "internal", risk: "destructive" },
  app_permissions: { kernel: "internal", risk: "safe" },

  // ── Issues / tasks ──
  issue_create:  { kernel: "internal", risk: "workspace-write" },
  issue_list:    { kernel: "internal", risk: "safe" },
  issue_update:  { kernel: "internal", risk: "workspace-write" },
  issue_checkout:{ kernel: "internal", risk: "workspace-write" },
  issue_release: { kernel: "internal", risk: "workspace-write" },
  issue_search:  { kernel: "internal", risk: "safe" },
  task_create:   { kernel: "internal", risk: "workspace-write" },
  task_get:      { kernel: "internal", risk: "safe" },
  task_list:     { kernel: "internal", risk: "safe" },
  task_update:   { kernel: "internal", risk: "workspace-write" },

  // ── Operations / worker-pool ──
  operation_start:   { kernel: "internal", risk: "workspace-write" },
  operation_list:    { kernel: "internal", risk: "safe" },
  operation_status:  { kernel: "internal", risk: "safe" },
  operation_next:    { kernel: "internal", risk: "safe" },
  operation_advance: { kernel: "internal", risk: "workspace-write" },
  op_submit:         { kernel: "internal", risk: "workspace-write" },
  op_submit_async:   { kernel: "internal", risk: "workspace-write" },
  op_wait:           { kernel: "internal", risk: "safe" },
  op_status:         { kernel: "internal", risk: "safe" },
  op_kill:           { kernel: "internal", risk: "destructive" },
  op_redirect:       { kernel: "internal", risk: "workspace-write" },

  // ── Autopilot ──
  autopilot_start:  { kernel: "internal", risk: "workspace-write" },
  autopilot_status: { kernel: "internal", risk: "safe" },
  autopilot_stop:   { kernel: "internal", risk: "destructive" },

  // ── App-build pipeline ──
  build_app:             { kernel: "internal", risk: "workspace-write" },
  create_page:           { kernel: "internal", risk: "workspace-write" },
  start_app_build:       { kernel: "internal", risk: "workspace-write" },
  finalize_app_build:    { kernel: "internal", risk: "workspace-write" },
  primal_build_resume:   { kernel: "internal", risk: "workspace-write" },
  primal_build_status:   { kernel: "internal", risk: "safe" },
  primal_run_build_plan: { kernel: "internal", risk: "workspace-write" },

  // ── UI / state / config ──
  sidebar_pin:    { kernel: "internal", risk: "workspace-write" },
  sidebar_unpin:  { kernel: "internal", risk: "workspace-write" },
  voice_visual:   { kernel: "internal", risk: "safe" },
  session_status: { kernel: "internal", risk: "safe" },
  setting:        { kernel: "internal", risk: "workspace-write" },
  config_get:     { kernel: "internal", risk: "safe" },
  config_set:     { kernel: "internal", risk: "workspace-write" },
  clipboard_read: { kernel: "internal", risk: "safe" },
  clipboard_write:{ kernel: "internal", risk: "workspace-write" },

  // ── Diagnostics / planning ──
  doctor:          { kernel: "internal", risk: "safe" },
  usage_report:    { kernel: "internal", risk: "safe" },
  tool_search:     { kernel: "internal", risk: "safe" },
  list_monitors:   { kernel: "internal", risk: "safe" },
  enter_plan_mode: { kernel: "internal", risk: "safe" },
  exit_plan_mode:  { kernel: "internal", risk: "safe" },

  // ── Structured workspace documents (bounded by SecurityLayer) ──
  spreadsheet_read:         { kernel: "internal", risk: "safe" },
  spreadsheet_write:        { kernel: "internal", risk: "workspace-write" },
  spreadsheet_edit:         { kernel: "internal", risk: "workspace-write" },
  spreadsheet_query:        { kernel: "internal", risk: "safe" },
  document_create:          { kernel: "internal", risk: "workspace-write" },
  document_edit:            { kernel: "internal", risk: "workspace-write" },
  document_read:            { kernel: "internal", risk: "safe" },
  document_template:        { kernel: "internal", risk: "safe" },
  presentation_create:      { kernel: "internal", risk: "workspace-write" },
  presentation_add_slide:   { kernel: "internal", risk: "workspace-write" },
  presentation_from_outline:{ kernel: "internal", risk: "workspace-write" },
  pdf_create:               { kernel: "internal", risk: "workspace-write" },
  pdf_read:                 { kernel: "internal", risk: "safe" },
  pdf_extract_tables:       { kernel: "internal", risk: "safe" },
  pdf_merge:                { kernel: "internal", risk: "workspace-write" },
};
