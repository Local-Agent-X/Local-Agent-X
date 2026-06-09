// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Glob-family rules (cover concrete tools above + tools registered outside
// TOOLS) and the global sliding-window rate cap. No kernel/risk — policy
// patterns only.

import type { ToolPolicyEntry } from "./tool-policies.types.js";

export const TOOL_POLICIES_GLOBS: Record<string, ToolPolicyEntry> = {
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
