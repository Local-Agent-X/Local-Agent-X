// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Project containers, agent / swarm / delegation orchestration, missions /
// playbooks, and protocols (protocol_* family).

import type { ToolPolicyEntry } from "./tool-policies.types.js";

export const TOOL_POLICIES_ORCHESTRATION: Record<string, ToolPolicyEntry> = {
  // ── Project containers (project_* glob) ──
  project_create:       { kernel: "internal", risk: "workspace-write" },
  project_list:         { kernel: "internal", risk: "safe" },
  project_add_agent:    { kernel: "internal", risk: "workspace-write" },
  project_brief_read:   { kernel: "internal", risk: "safe" },
  project_brief_update: { kernel: "internal", risk: "workspace-write" },

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

};
