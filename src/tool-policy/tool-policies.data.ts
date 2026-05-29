// THE unified per-tool policy table. One entry per tool (or glob family),
// joining all four formerly-scattered policy sources:
//
//   kernel    — defense pipeline at dispatch (ari-kernel/evaluate.ts)
//   risk      — what the user loses if it fires unapproved (autonomy gate)
//   rules     — explicit allow/deny/confirm rules (priority, argMatch, action,
//               constraints) — the old DEFAULT_POLICY.rules, re-homed per tool
//   rateLimit — sliding-window cap — the old DEFAULT_LIMITS
//
// Adding a tool is now ONE edit here. The derivations (tool-policies.ts)
// project this table into TOOLS / DEFAULT_POLICY / DEFAULT_LIMITS for the
// downstream consumers, and auditPolicyCoverage cross-checks that every
// kernel tool is reachable by a rule (no silent risk-tier fallback anymore).
//
// Keys are tool names OR glob patterns ("memory_*"): a concrete tool entry
// carries kernel+risk; a glob entry carries only the shared rule that covers
// a family. A tool's decision may therefore come from its own entry or from
// its family glob — both live in this one table.
//
// SECURITY INVARIANT (AGENTS.md): new tools need an EXPLICIT allow-<name>
// rule; default-deny. Do not add a broad "*"-style allow that would silently
// admit future tools.

import type { KernelClass, ToolRisk } from "../tool-registry.js";
import type { ToolPolicyRule } from "./types.js";

export interface ToolRateLimit {
  maxCalls: number;
  windowMs: number;
  action: "block" | "warn" | "throttle";
}

export interface ToolPolicyEntry {
  /** Present on concrete tools — feeds TOOLS / TOOL_CLASS_MAP / TOOL_RISK. */
  kernel?: KernelClass;
  risk?: ToolRisk;
  /** Explicit policy rule(s) for this tool or glob. `tool` is stamped from the
   *  record key by deriveDefaultRules — omit it here. */
  rules?: Array<Omit<ToolPolicyRule, "tool">>;
  /** Sliding-window rate cap (was DEFAULT_LIMITS in tool-execution/rate-limiter.ts). */
  rateLimit?: ToolRateLimit;
}

export const TOOL_POLICIES: Record<string, ToolPolicyEntry> = {
  // ── Shell / subprocess ──
  bash: {
    kernel: "shell", risk: "shell",
    rateLimit: { maxCalls: 30, windowMs: 60_000, action: "block" },
    rules: [
      { id: "deny-bash-rm-rf", decision: "deny", reason: "Blocked: rm -rf is too dangerous for automated execution", priority: 90, argMatch: { command: "rm -rf *" } },
      { id: "deny-bash-format", decision: "deny", reason: "Blocked: format/fdisk commands", priority: 90, argMatch: { command: "format *" } },
      { id: "deny-bash-del-system", decision: "deny", reason: "Blocked: cannot delete system files", priority: 90, argMatch: { command: "del /f /s /q C:\\Windows*" } },
      { id: "allow-bash-git", decision: "allow", reason: "Git commands allowed", priority: 50, argMatch: { command: "git *" } },
      { id: "allow-bash-limited", decision: "allow", reason: "Shell allowed (rate limited, command-checked)", priority: 40, constraints: { maxCallsPerSession: 30 } },
    ],
  },
  ari_shell:        { kernel: "internal", risk: "shell" },
  process_start:    { kernel: "shell",    risk: "shell" },
  process_status:   { kernel: "shell",    risk: "safe" },
  process_kill:     { kernel: "shell",    risk: "destructive" },
  process_list:     { kernel: "shell",    risk: "safe" },

  // ── Raw filesystem ──
  read:        { kernel: "file", risk: "safe", rules: [{ id: "allow-read", decision: "allow", reason: "File read (path-checked by SecurityLayer)", priority: 50 }] },
  write: {
    kernel: "file", risk: "workspace-write",
    rateLimit: { maxCalls: 50, windowMs: 60_000, action: "warn" },
    rules: [
      { id: "deny-write-system", decision: "deny", reason: "Blocked: cannot write to system directories", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-write-node-modules", decision: "deny", reason: "Blocked: do not write directly to node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-write", decision: "allow", reason: "File write (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  edit: {
    kernel: "file", risk: "workspace-write",
    rules: [
      { id: "deny-edit-system", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-edit-node-modules", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-edit", decision: "allow", reason: "File edit (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  // delete_file is the path-bounded alternative to `bash rm` — single file
  // per call, directories refused, workspace-bounded by SecurityLayer.
  delete_file: { kernel: "file", risk: "destructive", rules: [{ id: "allow-delete-file", decision: "allow", reason: "Single-file delete (path-checked by SecurityLayer, directories refused)", priority: 50 }] },
  glob:        { kernel: "file", risk: "safe", rules: [{ id: "allow-glob", decision: "allow", reason: "File pattern search (read-only)", priority: 50 }] },
  grep:        { kernel: "file", risk: "safe", rules: [{ id: "allow-grep", decision: "allow", reason: "Content search (read-only)", priority: 50 }] },
  view_image:  { kernel: "file", risk: "safe", rules: [{ id: "allow-view-image", decision: "allow", reason: "Image viewing (path-checked)", priority: 50 }] },
  ari_file:    { kernel: "internal", risk: "workspace-write" },

  // ── Network ──
  browser: {
    kernel: "http", risk: "network-read",
    rateLimit: { maxCalls: 15, windowMs: 60_000, action: "block" },
    rules: [
      { id: "flag-browser-evaluate", action: "evaluate", decision: "confirm", reason: "Browser JS evaluation — flagged for review", priority: 100 },
      { id: "allow-browser", decision: "allow", reason: "Browser allowed (rate limited)", priority: 40, constraints: { maxCallsPerSession: 100 } },
    ],
  },
  browser_capture_to_secret: { kernel: "secret-vault", risk: "secrets", rules: [{ id: "allow-browser-capture-to-secret", decision: "allow", reason: "Capture page value into encrypted vault (value never enters model context)", priority: 50 }] },
  browser_fill_from_secret:  { kernel: "secret-vault", risk: "secrets", rules: [{ id: "allow-browser-fill-from-secret", decision: "allow", reason: "Fill vault value into page input (origin-bound, selector-whitelisted, approval-gated)", priority: 50 }] },
  http_request: {
    kernel: "http", risk: "network-write",
    rateLimit: { maxCalls: 20, windowMs: 60_000, action: "block" },
    rules: [{ id: "allow-http-limited", decision: "allow", reason: "HTTP allowed (rate limited, SSRF-checked, content-wrapped)", priority: 40, constraints: { maxCallsPerSession: 60 } }],
  },
  ari_http: { kernel: "internal", risk: "network-write" },
  web_fetch: {
    kernel: "http", risk: "network-read",
    rateLimit: { maxCalls: 20, windowMs: 60_000, action: "block" },
    rules: [{ id: "allow-webfetch-limited", decision: "allow", reason: "Web fetch allowed (rate limited, SSRF-checked, content-wrapped)", priority: 40, constraints: { maxCallsPerSession: 60 } }],
  },
  web_search:          { kernel: "http", risk: "safe", rules: [{ id: "allow-web-search", decision: "allow", reason: "Web search", priority: 50 }] },
  youtube_analyze:     { kernel: "http", risk: "network-read" },
  extract_site_assets: { kernel: "http", risk: "network-read", rules: [{ id: "allow-extract-site-assets", decision: "allow", reason: "Web asset extraction (read-only)", priority: 50 }] },

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
  sql_query:           { kernel: "database", risk: "workspace-write" },
  sql_explain:         { kernel: "database", risk: "safe" },
  sql_schema:          { kernel: "database", risk: "safe" },
  ari_database:        { kernel: "internal", risk: "workspace-write" },
  ari_sqlite_database: { kernel: "internal", risk: "workspace-write" },

  // ── Retrieval / search ──
  ari_retrieval:        { kernel: "internal",  risk: "safe" },
  search_past_sessions: { kernel: "retrieval", risk: "safe", rules: [{ id: "allow-search-past-sessions", decision: "allow", reason: "Search prior chat sessions", priority: 50 }] },
  memory_search:        { kernel: "retrieval", risk: "safe" },

  // ── Secrets vault ──
  clipboard_write_from_secret: { kernel: "secret-vault", risk: "secrets" },
  request_secret:              { kernel: "internal", risk: "secrets", rules: [{ id: "allow-request-secret", decision: "allow", reason: "Secret request (user confirms via UI)", priority: 50 }] },
  request_secrets:             { kernel: "internal", risk: "secrets", rules: [{ id: "allow-request-secrets", decision: "allow", reason: "Multi-secret request (user confirms via UI)", priority: 50 }] },
  list_secrets:                { kernel: "internal", risk: "secrets", rules: [{ id: "allow-list-secrets", decision: "allow", reason: "List secret names (no values exposed)", priority: 50 }] },
  get_secret_meta:             { kernel: "internal", risk: "secrets", rules: [{ id: "allow-get-secret-meta", decision: "allow", reason: "Secret metadata (no values exposed)", priority: 50 }] },

  // ── Memory ── (memory_* glob covers all; remember/update_fact/forget are no-prefix)
  memory_save:           { kernel: "database", risk: "workspace-write" },
  memory_consolidate:    { kernel: "internal", risk: "workspace-write" },
  memory_discover:       { kernel: "internal", risk: "safe" },
  memory_dream:          { kernel: "internal", risk: "workspace-write" },
  memory_forget:         { kernel: "internal", risk: "destructive" },
  memory_forget_imports: { kernel: "internal", risk: "destructive" },
  memory_get:            { kernel: "internal", risk: "safe" },
  memory_ingest:         { kernel: "internal", risk: "workspace-write" },
  memory_recall:         { kernel: "internal", risk: "safe" },
  memory_reflect:        { kernel: "internal", risk: "workspace-write" },
  memory_reindex:        { kernel: "internal", risk: "workspace-write" },
  memory_stats:          { kernel: "internal", risk: "safe" },
  memory_set_user_field: { kernel: "internal", risk: "workspace-write" },
  memory_update_profile: { kernel: "internal", risk: "workspace-write" },
  remember:    { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-remember", decision: "allow", reason: "Save durable fact to Facts DB (internal)", priority: 50 }] },
  update_fact: { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-update-fact", decision: "allow", reason: "Correct a fact in the Facts DB (internal)", priority: 50 }] },
  forget:      { kernel: "internal", risk: "destructive", rules: [{ id: "allow-forget", decision: "allow", reason: "Soft-delete a fact in the Facts DB (internal)", priority: 50 }] },

  // ── Self-edit — sandboxed, but the merge mutates running source ──
  self_edit: { kernel: "internal", risk: "destructive", rules: [{ id: "allow-self-edit", decision: "allow", reason: "Agent self-repair via Claude Code subprocess", priority: 50 }] },

  // ── Project containers (project_* glob) ──
  project_create:    { kernel: "internal", risk: "workspace-write" },
  project_list:      { kernel: "internal", risk: "safe" },
  project_add_agent: { kernel: "internal", risk: "workspace-write" },

  // ── Agent / swarm / delegation orchestration ──
  agent_spawn:     { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-agent-spawn", decision: "allow", reason: "Agent delegation", priority: 50 }] },
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
  delegate:        { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-delegate", decision: "allow", reason: "Task delegation", priority: 50 }] },
  // swarm_* has no family glob today: the 4 read/create tools were allowed
  // only via the risk-tier synthetic fallback; swarm_cancel was uncovered
  // (deny-by-default) — now gated on approval (destructive, user-initiated).
  swarm_create:     { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-swarm-create", decision: "allow", reason: "Swarm creation", priority: 50 }] },
  swarm_status:     { kernel: "internal", risk: "safe", rules: [{ id: "allow-swarm-status", decision: "allow", reason: "Swarm status (read-only)", priority: 50 }] },
  swarm_cancel:     { kernel: "internal", risk: "destructive", rules: [{ id: "confirm-swarm-cancel", decision: "confirm", reason: "Swarm cancel requires approval (destructive, user-initiated)", priority: 50 }] },
  swarm_list_roles: { kernel: "internal", risk: "safe", rules: [{ id: "allow-swarm-list-roles", decision: "allow", reason: "Swarm role catalog (read-only)", priority: 50 }] },
  swarm_result:     { kernel: "internal", risk: "safe", rules: [{ id: "allow-swarm-result", decision: "allow", reason: "Swarm result (read-only)", priority: 50 }] },

  // ── Missions / playbooks ──
  // mission_schedule_* has a family glob (allow-mission-schedule). The
  // non-schedule mission_* tools below had no glob — allowed only via the
  // synthetic fallback (mission_delete was uncovered → deny, now approval-gated).
  mission_list:             { kernel: "internal", risk: "safe", rules: [{ id: "allow-mission-list", decision: "allow", reason: "Mission catalog (read-only)", priority: 50 }] },
  mission_get:              { kernel: "internal", risk: "safe", rules: [{ id: "allow-mission-get", decision: "allow", reason: "Mission detail (read-only)", priority: 50 }] },
  mission_save_preference:  { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-mission-save-preference", decision: "allow", reason: "Save mission preference", priority: 50 }] },
  mission_format_caption:   { kernel: "internal", risk: "safe", rules: [{ id: "allow-mission-format-caption", decision: "allow", reason: "Format mission caption (pure)", priority: 50 }] },
  mission_build:            { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-mission-build", decision: "allow", reason: "Build a mission definition", priority: 50 }] },
  mission_edit:             { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-mission-edit", decision: "allow", reason: "Edit a mission definition", priority: 50 }] },
  mission_delete:           { kernel: "internal", risk: "destructive", rules: [{ id: "confirm-mission-delete", decision: "confirm", reason: "Mission delete requires approval (destructive, user-initiated)", priority: 50 }] },
  mission_chain:            { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-mission-chain", decision: "allow", reason: "Chain missions", priority: 50 }] },
  mission_variables_set:    { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-mission-variables-set", decision: "allow", reason: "Set mission variable", priority: 50 }] },
  mission_variables_get:    { kernel: "internal", risk: "safe", rules: [{ id: "allow-mission-variables-get", decision: "allow", reason: "Get mission variable (read-only)", priority: 50 }] },
  mission_schedule_create:  { kernel: "internal", risk: "workspace-write" },
  mission_schedule_delete:  { kernel: "internal", risk: "destructive" },
  mission_schedule_list:    { kernel: "internal", risk: "safe" },
  mission_schedule_update:  { kernel: "internal", risk: "workspace-write" },
  mission_schedule_toggle:  { kernel: "internal", risk: "workspace-write" },
  mission_schedule_reports: { kernel: "internal", risk: "safe" },
  playbook_list:            { kernel: "internal", risk: "safe" },
  playbook_get:             { kernel: "internal", risk: "safe" },

  // ── Protocols (protocol_* glob) ──
  protocol_list:              { kernel: "internal", risk: "safe" },
  protocol_get:               { kernel: "internal", risk: "safe" },
  protocol_search:            { kernel: "internal", risk: "safe" },
  protocol_save_preference:   { kernel: "internal", risk: "workspace-write" },
  protocol_format_caption:    { kernel: "internal", risk: "safe" },
  protocol_dry_run:           { kernel: "internal", risk: "safe" },
  protocol_create:            { kernel: "internal", risk: "workspace-write" },
  protocol_edit:              { kernel: "internal", risk: "workspace-write" },
  protocol_delete:            { kernel: "internal", risk: "destructive" },
  protocol_unarchive:         { kernel: "internal", risk: "workspace-write" },
  protocol_pin:               { kernel: "internal", risk: "workspace-write" },
  protocol_list_archived:     { kernel: "internal", risk: "safe" },
  protocol_stats:             { kernel: "internal", risk: "safe" },
  protocol_prune:             { kernel: "internal", risk: "destructive" },
  protocol_archive_bulk:      { kernel: "internal", risk: "destructive" },
  protocol_curate:            { kernel: "internal", risk: "workspace-write" },
  protocol_curator_status:    { kernel: "internal", risk: "safe" },
  protocol_chain_create:      { kernel: "internal", risk: "workspace-write" },
  protocol_chain_start:       { kernel: "internal", risk: "workspace-write" },
  protocol_chain_advance:     { kernel: "internal", risk: "workspace-write" },
  protocol_rollback_init:     { kernel: "internal", risk: "workspace-write" },
  protocol_rollback_snapshot: { kernel: "internal", risk: "workspace-write" },
  protocol_rollback_undo:     { kernel: "internal", risk: "destructive" },
  protocol_rollback_history:  { kernel: "internal", risk: "safe" },
  protocol_progress_start:    { kernel: "internal", risk: "workspace-write" },
  protocol_progress_update:   { kernel: "internal", risk: "workspace-write" },
  protocol_progress_get:      { kernel: "internal", risk: "safe" },
  protocol_templates_list:    { kernel: "internal", risk: "safe" },
  protocol_from_template:     { kernel: "internal", risk: "workspace-write" },
  protocol_var_set:           { kernel: "internal", risk: "workspace-write" },
  protocol_var_get:           { kernel: "internal", risk: "safe" },
  protocol_var_delete:        { kernel: "internal", risk: "destructive" },
  protocol_var_list:          { kernel: "internal", risk: "safe" },
  protocol_var_interpolate:   { kernel: "internal", risk: "safe" },

  // ── Media generation / capture ──
  generate_image: { kernel: "internal", risk: "workspace-write", rateLimit: { maxCalls: 20, windowMs: 60_000, action: "block" }, rules: [{ id: "allow-generate-image", decision: "allow", reason: "Image generation allowed (rate limited)", priority: 40, constraints: { maxCallsPerSession: 20 } }] },
  generate_video: { kernel: "internal", risk: "workspace-write", rateLimit: { maxCalls: 5, windowMs: 60_000, action: "block" }, rules: [{ id: "allow-generate-video", decision: "allow", reason: "Video generation allowed (rate limited)", priority: 40, constraints: { maxCallsPerSession: 5 } }] },
  camera_capture: { kernel: "internal", risk: "workspace-write" },
  screen_capture: { kernel: "internal", risk: "workspace-write" },
  ocr:            { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-ocr", decision: "allow", reason: "OCR text extraction", priority: 50 }] },

  // ── Apps (app_* glob) ──
  app_create:      { kernel: "internal", risk: "workspace-write" },
  app_update:      { kernel: "internal", risk: "workspace-write" },
  app_read:        { kernel: "internal", risk: "safe" },
  app_action:      { kernel: "internal", risk: "workspace-write" },
  app_query:       { kernel: "internal", risk: "safe" },
  app_list:        { kernel: "internal", risk: "safe" },
  app_delete:      { kernel: "internal", risk: "destructive" },
  app_permissions: { kernel: "internal", risk: "safe" },

  // ── Issues / tasks (issue_* / task_* globs) ──
  issue_create:   { kernel: "internal", risk: "workspace-write" },
  issue_list:     { kernel: "internal", risk: "safe" },
  issue_update:   { kernel: "internal", risk: "workspace-write" },
  issue_checkout: { kernel: "internal", risk: "workspace-write" },
  issue_release:  { kernel: "internal", risk: "workspace-write" },
  issue_search:   { kernel: "internal", risk: "safe" },
  task_create:    { kernel: "internal", risk: "workspace-write" },
  task_get:       { kernel: "internal", risk: "safe" },
  task_list:      { kernel: "internal", risk: "safe" },
  task_update:    { kernel: "internal", risk: "workspace-write" },

  // ── Operations / worker-pool (operation_* / op_* globs) ──
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

  // ── Autopilot (autopilot_* glob) ──
  autopilot_start:  { kernel: "internal", risk: "workspace-write" },
  autopilot_status: { kernel: "internal", risk: "safe" },
  autopilot_stop:   { kernel: "internal", risk: "destructive" },

  // ── App-build pipeline ──
  build_app:             { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-build-app", decision: "allow", reason: "Build workspace apps", priority: 50 }] },
  create_page:           { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-create-page", decision: "allow", reason: "Create custom pages", priority: 50 }] },
  start_app_build:       { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-start-app-build", decision: "allow", reason: "App-build kickoff handle", priority: 50 }] },
  finalize_app_build:    { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-finalize-app-build", decision: "allow", reason: "App-build finalize handle", priority: 50 }] },
  primal_build_resume:   { kernel: "internal", risk: "workspace-write" },
  primal_build_status:   { kernel: "internal", risk: "safe" },
  primal_run_build_plan: { kernel: "internal", risk: "workspace-write" },

  // ── UI / state / config ──
  sidebar_pin:    { kernel: "internal", risk: "workspace-write" },
  sidebar_unpin:  { kernel: "internal", risk: "workspace-write" },
  sidebar_clear:  { kernel: "internal", risk: "workspace-write" },
  voice_visual:   { kernel: "internal", risk: "safe", rules: [{ id: "allow-voice-visual", decision: "allow", reason: "Particle visualizer (UI-only side effect, rate-limited)", priority: 50 }] },
  session_status: { kernel: "internal", risk: "safe", rules: [{ id: "allow-session-status", decision: "allow", reason: "Current session info", priority: 50 }] },
  setting:        { kernel: "internal", risk: "workspace-write", rules: [{ id: "allow-setting", decision: "allow", reason: "Agent settings flip (toggles, theme, provider — runtime state user can also change via UI)", priority: 50 }] },
  clipboard_read:  { kernel: "internal", risk: "safe" },
  clipboard_write: { kernel: "internal", risk: "workspace-write" },

  // ── Diagnostics / planning ──
  doctor:          { kernel: "internal", risk: "safe", rules: [{ id: "allow-doctor", decision: "allow", reason: "System self-diagnostics (read-only)", priority: 50 }] },
  usage_report:    { kernel: "internal", risk: "safe", rules: [{ id: "allow-usage-report", decision: "allow", reason: "Token usage / cost report (read-only)", priority: 50 }] },
  tool_search:     { kernel: "internal", risk: "safe", rules: [{ id: "allow-tool-search", decision: "allow", reason: "Discover available tools", priority: 50 }] },
  list_monitors:   { kernel: "internal", risk: "safe", rules: [{ id: "allow-list-monitors", decision: "allow", reason: "Enumerate available display monitors", priority: 50 }] },
  enter_plan_mode: { kernel: "internal", risk: "safe", rules: [{ id: "allow-enter-plan", decision: "allow", reason: "Enter read-only plan mode", priority: 50 }] },
  exit_plan_mode:  { kernel: "internal", risk: "safe", rules: [{ id: "allow-exit-plan", decision: "allow", reason: "Exit plan mode", priority: 50 }] },

  // ── Structured workspace documents (bounded by SecurityLayer) ──
  spreadsheet_read:          { kernel: "internal", risk: "safe" },
  spreadsheet_write:         { kernel: "internal", risk: "workspace-write" },
  spreadsheet_edit:          { kernel: "internal", risk: "workspace-write" },
  spreadsheet_query:         { kernel: "internal", risk: "safe" },
  document_create:           { kernel: "internal", risk: "workspace-write" },
  document_edit:             { kernel: "internal", risk: "workspace-write" },
  document_read:             { kernel: "internal", risk: "safe" },
  document_template:         { kernel: "internal", risk: "safe" },
  presentation_create:       { kernel: "internal", risk: "workspace-write" },
  presentation_add_slide:    { kernel: "internal", risk: "workspace-write" },
  presentation_from_outline: { kernel: "internal", risk: "workspace-write" },
  pdf_create:                { kernel: "internal", risk: "workspace-write" },
  pdf_read:                  { kernel: "internal", risk: "safe" },
  pdf_extract_tables:        { kernel: "internal", risk: "safe" },
  pdf_merge:                 { kernel: "internal", risk: "workspace-write" },

  // ── Glob-family rules (cover concrete tools above + tools registered
  //    outside TOOLS). No kernel/risk — these are policy patterns only. ──
  "memory_*":            { rules: [{ id: "allow-memory", decision: "allow", reason: "Memory operations (internal)", priority: 50 }] },
  "operation_*":         { rules: [{ id: "allow-operations", decision: "allow", reason: "Operations orchestration (safe — writes only to workspace/operations/)", priority: 50 }] },
  "autopilot_*":         { rules: [{ id: "allow-autopilot", decision: "allow", reason: "Autopilot operations (bounded, isolated worktree)", priority: 50 }] },
  "op_*":                { rules: [{ id: "allow-op", decision: "allow", reason: "Worker pool ops — heavy work runs in isolated subprocess", priority: 50 }] },
  "process_*":           { rules: [{ id: "allow-process", decision: "allow", reason: "Long-running process sessions (in-process buffered)", priority: 50 }] },
  "ari_*":               { rules: [{ id: "allow-ari-bridge", decision: "allow", reason: "AriKernel executor bridge (kernel-side I/O with native sandboxing)", priority: 50 }] },
  "protocol_*":          { rules: [{ id: "allow-protocols", decision: "allow", reason: "Protocol browsing, workflows, and execution", priority: 50 }] },
  "agent_*":             { rules: [{ id: "allow-agent-ops", decision: "allow", reason: "Agent management", priority: 50 }] },
  "project_*":           { rules: [{ id: "allow-project-ops", decision: "allow", reason: "Project container management", priority: 50 }] },
  "agency_*":            { rules: [{ id: "allow-agency", decision: "allow", reason: "Agency orchestration", priority: 50 }] },
  "camera_*":            { rules: [{ id: "allow-camera", decision: "allow", reason: "Camera capture", priority: 50 }] },
  "screen_*":            { rules: [{ id: "allow-screen", decision: "allow", reason: "Screen capture", priority: 50 }] },
  "app_*":               { rules: [{ id: "allow-apps", decision: "allow", reason: "App creation and management", priority: 50 }] },
  "issue_*":             { rules: [{ id: "allow-issues", decision: "allow", reason: "Issue and task management", priority: 50 }] },
  "agent_team_*":        { rules: [{ id: "allow-agent-team", decision: "allow", reason: "Agent team management", priority: 50 }] },
  "sql_*":               { rules: [{ id: "allow-sql", decision: "allow", reason: "SQL database access (readonly default)", priority: 40, constraints: { maxCallsPerSession: 50 } }] },
  "email_*":             { rules: [{ id: "allow-email", decision: "allow", reason: "Email read/send (API token gated)", priority: 50 }] },
  "calendar_*":          { rules: [{ id: "allow-calendar", decision: "allow", reason: "Calendar management (API token gated)", priority: 50 }] },
  "contacts_*":          { rules: [{ id: "allow-contacts", decision: "allow", reason: "Contact management", priority: 50 }] },
  "cloud_*":             { rules: [{ id: "allow-cloud", decision: "allow", reason: "Cloud file access (API token gated)", priority: 50 }] },
  "notify*":             { rules: [{ id: "allow-notify", decision: "allow", reason: "Push notifications", priority: 50 }] },
  "spreadsheet_*":       { rules: [{ id: "allow-spreadsheet", decision: "allow", reason: "Spreadsheet read/write", priority: 50 }] },
  "pdf_*":               { rules: [{ id: "allow-pdf", decision: "allow", reason: "PDF read/generate/merge/fill", priority: 50 }] },
  "payment_*":           { rules: [{ id: "allow-payment", decision: "allow", reason: "Payment/invoice operations (API key gated)", priority: 40, constraints: { maxCallsPerSession: 30 } }] },
  "sms_*":               { rules: [{ id: "allow-sms", decision: "allow", reason: "SMS send/receive via Twilio", priority: 40, constraints: { maxCallsPerSession: 20 } }] },
  "voice_*":             { rules: [{ id: "allow-voice", decision: "allow", reason: "Voice transcription, TTS, calls", priority: 40, constraints: { maxCallsPerSession: 20 } }] },
  "clipboard_*":         { rules: [{ id: "allow-clipboard", decision: "allow", reason: "System clipboard access", priority: 50 }] },
  "crm_*":               { rules: [{ id: "allow-crm", decision: "allow", reason: "CRM contact/deal management", priority: 50 }] },
  "accounting_*":        { rules: [{ id: "allow-accounting", decision: "allow", reason: "Bookkeeping/accounting operations", priority: 50 }] },
  "shop_*":              { rules: [{ id: "allow-shop", decision: "allow", reason: "E-commerce order/product/customer management", priority: 50 }] },
  "document_*":          { rules: [{ id: "allow-document", decision: "allow", reason: "Word document create/read/edit", priority: 50 }] },
  "presentation_*":      { rules: [{ id: "allow-presentation", decision: "allow", reason: "PowerPoint create/edit", priority: 50 }] },
  "youtube_*":           { rules: [{ id: "allow-youtube", decision: "allow", reason: "YouTube analysis", priority: 50 }] },
  "task_*":              { rules: [{ id: "allow-task", decision: "allow", reason: "Task tracking (session-scoped)", priority: 50 }] },
  "mission_schedule_*":  { rules: [{ id: "allow-mission-schedule", decision: "allow", reason: "Mission scheduling (recurring agent runs, reports under workspace/missions/)", priority: 50 }] },
  "cron_*":              { rules: [{ id: "allow-cron", decision: "allow", reason: "Cron job management (mission/reminder backing)", priority: 50 }] },
  "sidebar_*":           { rules: [{ id: "allow-sidebar", decision: "allow", reason: "Sidebar pin/unpin (user's left rail)", priority: 50 }] },
  "primal_*":            { rules: [{ id: "allow-primal", decision: "allow", reason: "Primal auto-build pipeline (run_build_plan, build_status, build_resume)", priority: 50 }] },
  "marketplace_*":       { rules: [{ id: "allow-marketplace", decision: "allow", reason: "Protocol marketplace (search/install/list)", priority: 50 }] },
  "config_*":            { rules: [{ id: "allow-config", decision: "allow", reason: "Agent configuration read/write", priority: 50 }] },
  "skill_*":             { rules: [{ id: "allow-skills", decision: "allow", reason: "User-defined skill workflows", priority: 50 }] },
  "playbook_*":          { rules: [{ id: "allow-playbook", decision: "allow", reason: "Legacy playbook tools", priority: 50 }] },

  // ── Global sliding-window rate cap (was DEFAULT_LIMITS "*") ──
  "*": { rateLimit: { maxCalls: 200, windowMs: 60_000, action: "warn" } },
};
