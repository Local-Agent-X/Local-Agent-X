// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Project containers, agent orchestration, mission schedules and protocols
// (protocol_* family).

import type { ToolPolicyRow } from "./tool-policies.types.js";

export const TOOL_POLICIES_ORCHESTRATION: Record<string, ToolPolicyRow> = {
  // ── Project containers (project_* glob) ──
  project_create:       { kernel: "internal", risk: "workspace-write", capabilities: [] },
  project_list:         { kernel: "internal", risk: "safe", capabilities: [] },
  project_add_agent:    { kernel: "internal", risk: "workspace-write", capabilities: [] },
  project_brief_read:   { kernel: "internal", risk: "safe", capabilities: [] },
  project_brief_update: { kernel: "internal", risk: "workspace-write", capabilities: [] },

  // ── Agent / swarm / delegation orchestration ──
  agent_spawn:     { kernel: "internal", risk: "workspace-write", capabilities: [], rules: [{ id: "allow-agent-spawn", decision: "allow", reason: "Agent delegation", priority: 50 }] },
  agent_create:    { kernel: "internal", risk: "workspace-write", capabilities: [] },
  agent_redirect:  { kernel: "internal", risk: "workspace-write", capabilities: [] },
  agent_pause:     { kernel: "internal", risk: "workspace-write", capabilities: [] },
  agent_resume:    { kernel: "internal", risk: "workspace-write", capabilities: [] },
  agent_cancel:    { kernel: "internal", risk: "destructive", capabilities: [] },
  agent_status:    { kernel: "internal", risk: "safe", capabilities: [] },
  agent_output:    { kernel: "internal", risk: "safe", capabilities: [] },
  agent_message:   { kernel: "internal", risk: "workspace-write", capabilities: [] },
  agent_escalate:  { kernel: "internal", risk: "workspace-write", capabilities: [] },
  agent_list:      { kernel: "internal", risk: "safe", capabilities: [] },
  agent_team_list: { kernel: "internal", risk: "safe", capabilities: [] },
  agent_wakeup:    { kernel: "internal", risk: "workspace-write", capabilities: [] },
  agent_whoami:    { kernel: "internal", risk: "safe", capabilities: [] },

  // ── Mission schedules ──
  // mission_schedule_* (cron/tools.ts) has a family glob (allow-mission-schedule);
  // the entries below carry each tool's class and risk.
  mission_schedule_create:  { kernel: "internal", risk: "workspace-write", capabilities: [] },
  mission_schedule_delete:  { kernel: "internal", risk: "destructive", capabilities: [] },
  mission_schedule_list:    { kernel: "internal", risk: "safe", capabilities: [] },
  mission_schedule_update:  { kernel: "internal", risk: "workspace-write", capabilities: [] },
  mission_schedule_toggle:  { kernel: "internal", risk: "workspace-write", capabilities: [] },
  mission_schedule_reports: { kernel: "internal", risk: "safe", capabilities: [] },

  // ── MCP administration ──
  // Adds + connects an external MCP server: writes ~/.lax/mcp.json and spawns
  // the integrity-gated subprocess. Risk "shell" (subprocess spawn) so the
  // autonomy profile gates it like bash — Safe asks, Normal+ runs. kernel
  // "internal": LAX-managed spawn (the connection layer's integrity check +
  // ${...}-only placeholder expansion guard the command), like self_edit.
  mcp_add_server: { kernel: "internal", risk: "shell", capabilities: [], rules: [{ id: "allow-mcp-add-server", decision: "allow", reason: "Add + connect an external MCP server", priority: 50 }] },

  // ── Protocols ──
  // One collapsed tool (action param) — see src/protocols/protocol-tool.ts.
  // Risk is the worst non-destructive tier across actions; the destructive
  // actions (delete, prune, archive_bulk, rollback_undo, var_delete, install,
  // update, curate) are reclassified per-call by the action-aware table in
  // approval-decision.ts.
  protocol: { kernel: "internal", risk: "workspace-write", capabilities: [], rules: [{ id: "allow-protocols", decision: "allow", reason: "Protocol browsing, workflows, and execution", priority: 50 }] },
};
