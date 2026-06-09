// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Media generation/capture, apps, issues/tasks, operations/worker-pool,
// autopilot, app-build pipeline, UI/state/config, diagnostics/planning, and
// structured workspace documents.

import type { ToolPolicyEntry } from "./tool-policies.types.js";

export const TOOL_POLICIES_APPS: Record<string, ToolPolicyEntry> = {
  // ── Media generation / capture ──
  generate_image: { kernel: "internal", risk: "workspace-write", offBoxFetch: true, rateLimit: { maxCalls: 20, windowMs: 60_000, action: "block" }, rules: [{ id: "allow-generate-image", decision: "allow", reason: "Image generation allowed (rate limited)", priority: 40, constraints: { maxCallsPerSession: 20 } }] },
  generate_video: { kernel: "internal", risk: "workspace-write", offBoxFetch: true, rateLimit: { maxCalls: 5, windowMs: 60_000, action: "block" }, rules: [{ id: "allow-generate-video", decision: "allow", reason: "Video generation allowed (rate limited)", priority: 40, constraints: { maxCallsPerSession: 5 } }] },
  camera_capture: { kernel: "internal", risk: "workspace-write" },
  screen_capture: { kernel: "internal", risk: "workspace-write" },
  ocr:            { kernel: "internal", risk: "workspace-write", pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-ocr", decision: "allow", reason: "OCR text extraction", priority: 50 }] },

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
  read_my_logs:   { kernel: "internal", risk: "safe", rules: [{ id: "allow-read-my-logs", decision: "allow", reason: "Agent's own action history (read-only)", priority: 50 }] },
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

  // ── Structured workspace documents ──
  // kernel:"internal" = no kernel-side taint/grant pipeline; file-access-mode
  // confinement is enforced by SecurityLayer via the pathArgs declarations
  // below (these tools open CALLER-supplied paths — without a declaration they
  // bypassed the workspace boundary entirely, the office-doc breach).
  spreadsheet_read:          { kernel: "internal", risk: "safe",            pathArgs: [{ arg: "file_path", action: "read" }] },
  spreadsheet_write:         { kernel: "internal", risk: "workspace-write", pathArgs: [{ arg: "file_path", action: "write" }] },
  spreadsheet_edit:          { kernel: "internal", risk: "workspace-write", pathArgs: [{ arg: "file_path", action: "write" }] },
  spreadsheet_query:         { kernel: "internal", risk: "safe",            pathArgs: [{ arg: "file_path", action: "read" }] },
  document_create:           { kernel: "internal", risk: "workspace-write", pathArgs: [{ arg: "file_path", action: "write" }] },
  document_edit:             { kernel: "internal", risk: "workspace-write", pathArgs: [{ arg: "file_path", action: "write" }] },
  document_read:             { kernel: "internal", risk: "safe",            pathArgs: [{ arg: "file_path", action: "read" }] },
  document_template:         { kernel: "internal", risk: "safe",            pathArgs: [{ arg: "template_path", action: "read" }, { arg: "output_path", action: "write" }] },
  presentation_create:       { kernel: "internal", risk: "workspace-write", pathArgs: [{ arg: "file_path", action: "write" }] },
  presentation_add_slide:    { kernel: "internal", risk: "workspace-write", pathArgs: [{ arg: "file_path", action: "write" }] },
  presentation_from_outline: { kernel: "internal", risk: "workspace-write", pathArgs: [{ arg: "file_path", action: "write" }] },
  pdf_create:                { kernel: "internal", risk: "workspace-write", pathArgs: [{ arg: "file_path", action: "write" }] },
  pdf_read:                  { kernel: "internal", risk: "safe",            pathArgs: [{ arg: "file_path", action: "read" }] },
  pdf_extract_tables:        { kernel: "internal", risk: "safe",            pathArgs: [{ arg: "file_path", action: "read" }] },
  pdf_merge:                 { kernel: "internal", risk: "workspace-write", pathArgs: [{ arg: "files", action: "read", json: true }, { arg: "output_path", action: "write" }] },
};
