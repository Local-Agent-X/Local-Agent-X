// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Glob-family rules (cover concrete tools above + tools registered outside
// TOOLS) and the global sliding-window rate cap. No kernel/risk — policy
// patterns only.

import type { GlobPolicyEntry } from "./tool-policies.types.js";

export const TOOL_POLICIES_GLOBS: Record<string, GlobPolicyEntry> = {
  // ── Glob-family rules (cover concrete tools above + tools registered
  //    outside TOOLS). No kernel/risk — these are policy patterns only.
  //    Every glob must match a tool that exists, or a family registered at
  //    runtime (tool-registration-completeness.test.ts): a glob for tools
  //    nobody has written is a pre-approval waiting for any tool of that name. ──
  "memory_*":            { rules: [{ id: "allow-memory", decision: "allow", reason: "Memory operations (internal)", priority: 50 }] },
  "autopilot_*":         { rules: [{ id: "allow-autopilot", decision: "allow", reason: "Autopilot operations (bounded, isolated worktree)", priority: 50 }] },
  "op_*":                { rules: [{ id: "allow-op", decision: "allow", reason: "Worker pool ops — heavy work runs in isolated subprocess", priority: 50 }] },
  "process_*":           { rules: [{ id: "allow-process", decision: "allow", reason: "Long-running process sessions (in-process buffered)", priority: 50 }] },
  "ari_*":               { rules: [{ id: "allow-ari-bridge", decision: "allow", reason: "AriKernel executor bridge (kernel-side I/O with native sandboxing)", priority: 50 }] },
  "agent_*":             { rules: [{ id: "allow-agent-ops", decision: "allow", reason: "Agent management", priority: 50 }] },
  "project_*":           { rules: [{ id: "allow-project-ops", decision: "allow", reason: "Project container management", priority: 50 }] },
  "camera_*":            { rules: [{ id: "allow-camera", decision: "allow", reason: "Camera capture", priority: 50 }] },
  "screen_*":            { rules: [{ id: "allow-screen", decision: "allow", reason: "Screen capture", priority: 50 }] },
  "app_*":               { rules: [{ id: "allow-apps", decision: "allow", reason: "App creation and management", priority: 50 }] },
  "issue_*":             { rules: [{ id: "allow-issues", decision: "allow", reason: "Issue and task management", priority: 50 }] },
  "agent_team_*":        { rules: [{ id: "allow-agent-team", decision: "allow", reason: "Agent team management", priority: 50 }] },
  "sql_*":               { rules: [{ id: "allow-sql", decision: "allow", reason: "SQL database access (readonly default)", priority: 40, constraints: { maxCallsPerSession: 50 } }] },
  "email_*":             { rules: [{ id: "allow-email", decision: "allow", reason: "Email read/send (API token gated)", priority: 50 }] },
  "calendar_*":          { rules: [{ id: "allow-calendar", decision: "allow", reason: "Calendar management (API token gated)", priority: 50 }] },
  "voice_*":             { rules: [{ id: "allow-voice", decision: "allow", reason: "Voice transcription, TTS, calls", priority: 40, constraints: { maxCallsPerSession: 20 } }] },
  "clipboard_*":         { rules: [{ id: "allow-clipboard", decision: "allow", reason: "System clipboard access", priority: 50 }] },
  "youtube_*":           { rules: [{ id: "allow-youtube", decision: "allow", reason: "YouTube analysis", priority: 50 }] },
  "task_*":              { rules: [{ id: "allow-task", decision: "allow", reason: "Task tracking (session-scoped)", priority: 50 }] },
  "mission_schedule_*":  { rules: [{ id: "allow-mission-schedule", decision: "allow", reason: "Mission scheduling (recurring agent runs, reports under workspace/missions/)", priority: 50 }] },
  "sidebar_*":           { rules: [{ id: "allow-sidebar", decision: "allow", reason: "Sidebar pin/unpin (user's left rail)", priority: 50 }] },
  "marketplace_*":       { rules: [{ id: "allow-marketplace", decision: "allow", reason: "Protocol marketplace (search/install/list)", priority: 50 }] },
  // External MCP-server tools (mcp_<server>_<tool>) register at runtime, so they
  // never get a concrete entry above and would hit deny-by-default. They ARE a
  // user-authorized integration surface; allow them here while the ARI kernel
  // (http class + taint rules) and the autonomy profile still gate every call.
  "mcp_*":               { rules: [{ id: "allow-mcp", decision: "allow", reason: "External MCP server tools (user-configured; kernel + taint gate each call)", priority: 40, constraints: { maxCallsPerSession: 100 } }] },

  // ── Global sliding-window rate cap (was DEFAULT_LIMITS "*") ──
  "*": { rateLimit: { maxCalls: 200, windowMs: 60_000, action: "warn" } },
};
