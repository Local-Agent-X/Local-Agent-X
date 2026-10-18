// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Project containers, agent orchestration, mission schedules and protocols
// (protocol_* family).

import type { ToolPolicyRow } from "./tool-policies.types.js";

export const TOOL_POLICIES_ORCHESTRATION: Record<string, ToolPolicyRow> = {
  // ── Project containers (project_* glob) ──
  project_create:       { kernel: "internal", risk: "workspace-write", capabilities: [], reads: ["session"] },
  project_list:         { kernel: "internal", risk: "safe", capabilities: [] },
  project_add_agent:    { kernel: "internal", risk: "workspace-write", capabilities: [] },
  project_brief_read:   { kernel: "internal", risk: "safe", capabilities: [] },
  project_brief_update: { kernel: "internal", risk: "workspace-write", capabilities: [], reads: ["session"] },

  // ── Agent / swarm / delegation orchestration ──
  // The chat's current project flows into a spawn's scope (catalog filter +
  // tool gate) unless the call names one. agent_spawn keys spawn lineage and
  // the child's inherited bans on the calling op; agent_create caps what an
  // agent may grant by the calling run's own tools. An IDE session's chat may
  // not spawn or steer workers.
  agent_spawn:     { kernel: "internal", risk: "workspace-write", capabilities: [], timeoutMs: 0, reads: ["session", "operation", "project"], hiddenFrom: { ide: "an in-editor chat does not spawn workers" }, rules: [{ id: "allow-agent-spawn", decision: "allow", reason: "Agent delegation", priority: 50 }] },
  agent_create:    { kernel: "internal", risk: "workspace-write", capabilities: [], timeoutMs: 0, reads: ["session", "project"] },
  agent_redirect:  { kernel: "internal", risk: "workspace-write", capabilities: [] },
  agent_pause:     { kernel: "internal", risk: "workspace-write", capabilities: [], hiddenFrom: { ide: "an in-editor chat does not steer workers" } },
  agent_resume:    { kernel: "internal", risk: "workspace-write", capabilities: [], hiddenFrom: { ide: "an in-editor chat does not steer workers" } },
  agent_cancel:    { kernel: "internal", risk: "destructive", capabilities: [], hiddenFrom: { ide: "an in-editor chat does not steer workers" }, undo: { irreversible: "a spawned agent's run", uncarded: "stops a spawned agent's run; nothing the user owns is destroyed" } },
  agent_status:    { kernel: "internal", risk: "safe", capabilities: [], liveState: "poll", loop: { discovery: true }, hiddenFrom: { ide: "an in-editor chat does not steer workers" } },
  agent_output:    { kernel: "internal", risk: "safe", capabilities: [], liveState: "poll", loop: { discovery: true } },
  agent_message:   { kernel: "internal", risk: "workspace-write", capabilities: [], hiddenFrom: {
    mcp: "it is the reply-to-agent primitive used inside agency, not by the user-facing supervisor",
    ide: "an in-editor chat does not steer workers",
  } },
  agent_escalate:  { kernel: "internal", risk: "workspace-write", capabilities: [], reads: ["session"], runControl: true },
  agent_list:      { kernel: "internal", risk: "safe", capabilities: [], liveState: "fresh", reads: ["project"] },
  agent_team_list: { kernel: "internal", risk: "safe", capabilities: [], liveState: "fresh", loop: { discovery: true } },
  // Wakes another agent through the canonical invoke door; the calling RUN
  // (spawn lineage) is derived from the trusted session.
  agent_wakeup:    { kernel: "internal", risk: "workspace-write", capabilities: [], reads: ["session"] },
  agent_whoami:    { kernel: "internal", risk: "safe", capabilities: [], loop: { discovery: true } },

  // ── Mission schedules ──
  // mission_schedule_* (cron/tools.ts) has a family glob (allow-mission-schedule);
  // the entries below carry each tool's class and risk.
  mission_schedule_create:  { kernel: "internal", risk: "workspace-write", capabilities: [] },
  mission_schedule_delete:  { kernel: "internal", risk: "destructive", capabilities: [], undo: { pairedWith: "mission_schedule_create" } },
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
  // The family's risk is its worst non-destructive tier; these actions are
  // destructive, so collapsing the family never weakens their approval gate.
  // Dispatch only ever sees `protocol`, so the stamps its inner actions read
  // (the calling session, the op it runs in) are declared here.
  protocol: {
    kernel: "internal", risk: "workspace-write", capabilities: [], reads: ["session", "operation"],
    destructiveActions: {
      delete: "deletes a saved protocol",
      prune: "bulk-archives unused protocols",
      archive_bulk: "bulk-archives protocols",
      rollback_undo: "rewinds a protocol execution to an earlier step snapshot",
      var_delete: "deletes a stored protocol variable",
      install: "downloads skills from a repo and writes them into the workspace",
      update: "overwrites an installed skill with its upstream version",
      curate: "archives stale protocols and hard-deletes archived ones past their cutoff",
    },
    rules: [{ id: "allow-protocols", decision: "allow", reason: "Protocol browsing, workflows, and execution", priority: 50 }],
  },
};
