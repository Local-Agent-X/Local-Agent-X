import type { ToolPolicyConfig } from "./types.js";

// DEFAULT-DENY: everything is blocked unless explicitly allowed.
// This is the enterprise-safe posture. Users can override via ~/.lax/tool-policy.json.
export const DEFAULT_POLICY: ToolPolicyConfig = {
  defaultDecision: "deny",
  rules: [
    // ── Explicitly ALLOWED tools (safe by design) ──

    // File operations — safe, gated by SecurityLayer path checks
    { id: "allow-read", tool: "read", decision: "allow", reason: "File read (path-checked by SecurityLayer)", priority: 50 },
    { id: "allow-write", tool: "write", decision: "allow", reason: "File write (path-checked by SecurityLayer)", priority: 50 },
    { id: "allow-edit", tool: "edit", decision: "allow", reason: "File edit (path-checked by SecurityLayer)", priority: 50 },
    // delete_file is the path-bounded alternative to `bash rm` — the
    // shell-policy correctly blocks `rm -f`/`rm -r` to prevent
    // catastrophic mistakes, and this tool is the scoped escape valve.
    // SecurityLayer enforces workspace bounds the same way it does for
    // read/write/edit. Single file per call, directories refused.
    { id: "allow-delete-file", tool: "delete_file", decision: "allow", reason: "Single-file delete (path-checked by SecurityLayer, directories refused)", priority: 50 },

    // Memory tools — safe, internal only
    { id: "allow-memory", tool: "memory_*", decision: "allow", reason: "Memory operations (internal)", priority: 50 },

    // Operations — long-horizon goal orchestration, writes only to workspace/operations/
    { id: "allow-operations", tool: "operation_*", decision: "allow", reason: "Operations orchestration (safe — writes only to workspace/operations/)", priority: 50 },

    // Autopilot — bounded autonomous work, runs in isolated git worktree
    { id: "allow-autopilot", tool: "autopilot_*", decision: "allow", reason: "Autopilot operations (bounded, isolated worktree)", priority: 50 },

    // Worker pool — op_submit/status/kill/redirect, heavy work in isolated subprocess
    { id: "allow-op", tool: "op_*", decision: "allow", reason: "Worker pool ops — heavy work runs in isolated subprocess", priority: 50 },

    // Long-running processes — process_start/status/kill/list. Same address
    // space as the agent (no subprocess agent), session-buffered output, the
    // right primitive for "wait for a 5-minute install" instead of bash
    // blocking the turn or escalating to op_submit_async.
    { id: "allow-process", tool: "process_*", decision: "allow", reason: "Long-running process sessions (in-process buffered)", priority: 50 },

    // Secrets — request triggers UI prompt, list shows names only
    { id: "allow-request-secret", tool: "request_secret", decision: "allow", reason: "Secret request (user confirms via UI)", priority: 50 },
    { id: "allow-request-secrets", tool: "request_secrets", decision: "allow", reason: "Multi-secret request (user confirms via UI)", priority: 50 },
    { id: "allow-list-secrets", tool: "list_secrets", decision: "allow", reason: "List secret names (no values exposed)", priority: 50 },

    // voice_visual — read-only side-effect (emits a UI event); rate-limited
    // inside the tool itself (1 call/turn + 2.5s cooldown). No external I/O.
    { id: "allow-voice-visual", tool: "voice_visual", decision: "allow", reason: "Particle visualizer (UI-only side effect, rate-limited)", priority: 50 },

    // AriKernel executor bridge — kernel-side file/http/shell/database/retrieval
    // adapters registered by createArikernelBridgeTools. They carry the kernel's
    // own sandboxing (path-tainting, SSRF, shell metachar rejection); the SAX
    // security layer + pre-dispatch gate also fire on top. Bridge tools are
    // deferred (model has to discover them via tool_search), so this allow is
    // the explicit policy nod that lets the unified evaluator dispatch to them.
    { id: "allow-ari-bridge", tool: "ari_*", decision: "allow", reason: "AriKernel executor bridge (kernel-side I/O with native sandboxing)", priority: 50 },

    // ── ARGUMENT-MATCHED rules (deny dangerous patterns before general allow) ──

    // Block destructive bash commands
    { id: "deny-bash-rm-rf", tool: "bash", decision: "deny", reason: "Blocked: rm -rf is too dangerous for automated execution", priority: 90, argMatch: { command: "rm -rf *" } },
    { id: "deny-bash-format", tool: "bash", decision: "deny", reason: "Blocked: format/fdisk commands", priority: 90, argMatch: { command: "format *" } },
    { id: "deny-bash-del-system", tool: "bash", decision: "deny", reason: "Blocked: cannot delete system files", priority: 90, argMatch: { command: "del /f /s /q C:\\Windows*" } },

    // Block writes to system/protected paths
    { id: "deny-write-system", tool: "write", decision: "deny", reason: "Blocked: cannot write to system directories", priority: 90, argMatch: { path: "C:\\Windows*" } },
    { id: "deny-edit-system", tool: "edit", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
    { id: "deny-write-node-modules", tool: "write", decision: "deny", reason: "Blocked: do not write directly to node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
    { id: "deny-edit-node-modules", tool: "edit", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },

    // Allow git commands at normal priority (useful documentation that argMatch works)
    { id: "allow-bash-git", tool: "bash", decision: "allow", reason: "Git commands allowed", priority: 50, argMatch: { command: "git *" } },

    // ── ALLOWED but RATE-LIMITED tools (can be abused) ──

    // Shell — rate limited, gated by SecurityLayer command checks
    {
      id: "allow-bash-limited",
      tool: "bash",
      decision: "allow",
      reason: "Shell allowed (rate limited, command-checked)",
      priority: 40,
      constraints: { maxCallsPerSession: 30 },
    },

    // HTTP — rate limited, gated by SSRF + DNS pinning
    {
      id: "allow-http-limited",
      tool: "http_request",
      decision: "allow",
      reason: "HTTP allowed (rate limited, SSRF-checked, content-wrapped)",
      priority: 40,
      constraints: { maxCallsPerSession: 60 },
    },

    // Web fetch — rate limited, simpler than http_request
    {
      id: "allow-webfetch-limited",
      tool: "web_fetch",
      decision: "allow",
      reason: "Web fetch allowed (rate limited, SSRF-checked, content-wrapped)",
      priority: 40,
      constraints: { maxCallsPerSession: 60 },
    },

    // Browser — rate limited, all actions except evaluate
    {
      id: "allow-browser",
      tool: "browser",
      decision: "allow",
      reason: "Browser allowed (rate limited)",
      priority: 40,
      constraints: { maxCallsPerSession: 100 },
    },

    // Privacy-preserving secret tools: server-side reads/writes the vault and
    // pipes the value to clipboard or page input. The value never enters the
    // model's context — only a length confirmation comes back. Origin
    // binding, selector whitelist, and approval ladder are enforced inside
    // each tool. ARI provides audit + behavioral observation.
    { id: "allow-browser-capture-to-secret", tool: "browser_capture_to_secret", decision: "allow", reason: "Capture page value into encrypted vault (value never enters model context)", priority: 50 },
    { id: "allow-browser-fill-from-secret", tool: "browser_fill_from_secret", decision: "allow", reason: "Fill vault value into page input (origin-bound, selector-whitelisted, approval-gated)", priority: 50 },

    // View image — safe, path-checked by SecurityLayer
    { id: "allow-view-image", tool: "view_image", decision: "allow", reason: "Image viewing (path-checked)", priority: 50 },

    // Image generation — rate limited
    {
      id: "allow-generate-image",
      tool: "generate_image",
      decision: "allow",
      reason: "Image generation allowed (rate limited)",
      priority: 40,
      constraints: { maxCallsPerSession: 20 },
    },

    // Video generation — rate limited (slow + GPU intensive)
    {
      id: "allow-generate-video",
      tool: "generate_video",
      decision: "allow",
      reason: "Video generation allowed (rate limited)",
      priority: 40,
      constraints: { maxCallsPerSession: 5 },
    },

    // ── FLAGGED tools (allowed but logged as elevated risk) ──

    {
      id: "flag-browser-evaluate",
      tool: "browser",
      action: "evaluate",
      decision: "confirm",
      reason: "Browser JS evaluation — flagged for review",
      priority: 100,
    },

    // Protocols
    { id: "allow-protocols", tool: "protocol_*", decision: "allow", reason: "Protocol browsing, workflows, and execution", priority: 50 },

    // Agent delegation — required for Agent Handler
    { id: "allow-agent-spawn", tool: "agent_spawn", decision: "allow", reason: "Agent delegation", priority: 50 },
    { id: "allow-delegate", tool: "delegate", decision: "allow", reason: "Task delegation", priority: 50 },
    { id: "allow-agent-ops", tool: "agent_*", decision: "allow", reason: "Agent management", priority: 50 },

    // Agency — multi-agent orchestration
    { id: "allow-agency", tool: "agency_*", decision: "allow", reason: "Agency orchestration", priority: 50 },

    // Web search — safe, read-only
    { id: "allow-web-search", tool: "web_search", decision: "allow", reason: "Web search", priority: 50 },

    // Media tools — camera, screen, OCR
    { id: "allow-camera", tool: "camera_*", decision: "allow", reason: "Camera capture", priority: 50 },
    { id: "allow-screen", tool: "screen_*", decision: "allow", reason: "Screen capture", priority: 50 },
    { id: "allow-ocr", tool: "ocr", decision: "allow", reason: "OCR text extraction", priority: 50 },

    // Apps — in-platform app builder
    { id: "allow-apps", tool: "app_*", decision: "allow", reason: "App creation and management", priority: 50 },

    // Issues / Tasks — agent task management and approvals
    { id: "allow-issues", tool: "issue_*", decision: "allow", reason: "Issue and task management", priority: 50 },

    // Agent team management
    { id: "allow-agent-team", tool: "agent_team_*", decision: "allow", reason: "Agent team management", priority: 50 },

    // Build app / create page
    { id: "allow-build-app", tool: "build_app", decision: "allow", reason: "Build workspace apps", priority: 50 },
    { id: "allow-create-page", tool: "create_page", decision: "allow", reason: "Create custom pages", priority: 50 },
    { id: "allow-install-software", tool: "install_software", decision: "allow", reason: "OS-aware software installer (bounded timeout + http_request fallback)", priority: 50 },

    // ── Business & Personal Assistant tools ──

    // SQL — rate limited, readonly by default
    { id: "allow-sql", tool: "sql_*", decision: "allow", reason: "SQL database access (readonly default)", priority: 40, constraints: { maxCallsPerSession: 50 } },

    // Email
    { id: "allow-email", tool: "email_*", decision: "allow", reason: "Email read/send (API token gated)", priority: 50 },

    // Calendar
    { id: "allow-calendar", tool: "calendar_*", decision: "allow", reason: "Calendar management (API token gated)", priority: 50 },

    // Contacts
    { id: "allow-contacts", tool: "contacts_*", decision: "allow", reason: "Contact management", priority: 50 },

    // Cloud storage
    { id: "allow-cloud", tool: "cloud_*", decision: "allow", reason: "Cloud file access (API token gated)", priority: 50 },

    // Notifications
    { id: "allow-notify", tool: "notify*", decision: "allow", reason: "Push notifications", priority: 50 },

    // Spreadsheets
    { id: "allow-spreadsheet", tool: "spreadsheet_*", decision: "allow", reason: "Spreadsheet read/write", priority: 50 },

    // PDF
    { id: "allow-pdf", tool: "pdf_*", decision: "allow", reason: "PDF read/generate/merge/fill", priority: 50 },

    // Payments — rate limited for safety
    { id: "allow-payment", tool: "payment_*", decision: "allow", reason: "Payment/invoice operations (API key gated)", priority: 40, constraints: { maxCallsPerSession: 30 } },

    // SMS — rate limited
    { id: "allow-sms", tool: "sms_*", decision: "allow", reason: "SMS send/receive via Twilio", priority: 40, constraints: { maxCallsPerSession: 20 } },

    // Voice
    { id: "allow-voice", tool: "voice_*", decision: "allow", reason: "Voice transcription, TTS, calls", priority: 40, constraints: { maxCallsPerSession: 20 } },

    // Clipboard
    { id: "allow-clipboard", tool: "clipboard_*", decision: "allow", reason: "System clipboard access", priority: 50 },

    // CRM
    { id: "allow-crm", tool: "crm_*", decision: "allow", reason: "CRM contact/deal management", priority: 50 },

    // Bookkeeping
    { id: "allow-accounting", tool: "accounting_*", decision: "allow", reason: "Bookkeeping/accounting operations", priority: 50 },

    // E-commerce
    { id: "allow-shop", tool: "shop_*", decision: "allow", reason: "E-commerce order/product/customer management", priority: 50 },

    // Search tools — safe, read-only
    { id: "allow-glob", tool: "glob", decision: "allow", reason: "File pattern search (read-only)", priority: 50 },
    { id: "allow-grep", tool: "grep", decision: "allow", reason: "Content search (read-only)", priority: 50 },
    { id: "allow-tool-search", tool: "tool_search", decision: "allow", reason: "Discover available tools", priority: 50 },
    { id: "allow-self-edit", tool: "self_edit", decision: "allow", reason: "Agent self-repair via Claude Code subprocess", priority: 50 },

    // Document tools
    { id: "allow-document", tool: "document_*", decision: "allow", reason: "Word document create/read/edit", priority: 50 },
    { id: "allow-presentation", tool: "presentation_*", decision: "allow", reason: "PowerPoint create/edit", priority: 50 },

    // YouTube
    { id: "allow-youtube", tool: "youtube_*", decision: "allow", reason: "YouTube analysis", priority: 50 },

    // Task management — session-scoped tracking
    { id: "allow-task", tool: "task_*", decision: "allow", reason: "Task tracking (session-scoped)", priority: 50 },

    // Missions — scheduled recurring agent runs. Core user-facing feature
    // ("create a mission to do X every night"). Reports land under
    // workspace/missions/. Was missing from the default policy on 2026-05-17
    // so the agent's mission_schedule_create attempts were silently blocked,
    // forcing a fallback to agent_spawn that produced text but not a real
    // recurring schedule.
    { id: "allow-mission-schedule", tool: "mission_schedule_*", decision: "allow", reason: "Mission scheduling (recurring agent runs, reports under workspace/missions/)", priority: 50 },

    // Cron — backing schedule layer for missions and any other recurring jobs.
    { id: "allow-cron", tool: "cron_*", decision: "allow", reason: "Cron job management (mission/reminder backing)", priority: 50 },

    // ── Tool-policy coverage backfill 2026-05-17 ──
    // These are real registered tools (ToolDefinition with execute()) that
    // weren't covered by any existing pattern, so the deny-by-default
    // posture silently blocked them at runtime. Same class as the
    // mission_schedule_* miss earlier: missed when first written, only
    // visible in production. Verified each is a real user-facing tool,
    // not a protocol/playbook name or a startup-test result.

    // Sidebar pin/unpin — agent manages the user's app sidebar.
    { id: "allow-sidebar", tool: "sidebar_*", decision: "allow", reason: "Sidebar pin/unpin (user's left rail)", priority: 50 },

    // Primal auto-build — multi-step app construction pipeline.
    { id: "allow-primal", tool: "primal_*", decision: "allow", reason: "Primal auto-build pipeline (run_build_plan, build_status, build_resume)", priority: 50 },

    // Sub-pieces of the app-build flow that don't share the build_app prefix.
    { id: "allow-start-app-build", tool: "start_app_build", decision: "allow", reason: "App-build kickoff handle", priority: 50 },
    { id: "allow-finalize-app-build", tool: "finalize_app_build", decision: "allow", reason: "App-build finalize handle", priority: 50 },

    // Web asset extraction — scrape images/css/assets from a page.
    { id: "allow-extract-site-assets", tool: "extract_site_assets", decision: "allow", reason: "Web asset extraction (read-only)", priority: 50 },

    // Secrets metadata — list-secrets is allowed, this is its companion
    // (names + capture origin, no values).
    { id: "allow-get-secret-meta", tool: "get_secret_meta", decision: "allow", reason: "Secret metadata (no values exposed)", priority: 50 },

    // Session introspection — current session info + search past sessions.
    { id: "allow-session-status", tool: "session_status", decision: "allow", reason: "Current session info", priority: 50 },
    { id: "allow-search-past-sessions", tool: "search_past_sessions", decision: "allow", reason: "Search prior chat sessions", priority: 50 },

    // Vision — list_monitors complements the already-allowed screen_*/camera_*.
    { id: "allow-list-monitors", tool: "list_monitors", decision: "allow", reason: "Enumerate available display monitors", priority: 50 },

    // Diagnostics + cost reporting.
    { id: "allow-doctor", tool: "doctor", decision: "allow", reason: "System self-diagnostics (read-only)", priority: 50 },
    { id: "allow-usage-report", tool: "usage_report", decision: "allow", reason: "Token usage / cost report (read-only)", priority: 50 },

    // Protocol marketplace — search/install/list community protocols.
    // Caught by the 2026-05-17 boot-time coverage audit (third backfill
    // wave); the marketplace.ts module registers both protocol metadata
    // AND backing tools, so the earlier "filter out protocols" pass
    // missed these.
    { id: "allow-marketplace", tool: "marketplace_*", decision: "allow", reason: "Protocol marketplace (search/install/list)", priority: 50 },

    // Plan mode
    { id: "allow-enter-plan", tool: "enter_plan_mode", decision: "allow", reason: "Enter read-only plan mode", priority: 50 },
    { id: "allow-exit-plan", tool: "exit_plan_mode", decision: "allow", reason: "Exit plan mode", priority: 50 },

    // Config
    { id: "allow-config", tool: "config_*", decision: "allow", reason: "Agent configuration read/write", priority: 50 },

    // Schema-driven settings flip surface. `setting` is the agent's path to
    // change runtime config (theme, provider, enableShell, etc.) — the same
    // state the user can mutate via UI. The operational gates that actually
    // enforce safety (e.g. denying bash when enableShell=false) live in
    // src/tools/pre-dispatch.ts and fire on the next tool call, not on the
    // toggle itself. Pre-2026-05-20 this tool was missing from the policy,
    // which logged ERROR every boot (1 of 192 tools without a rule) and
    // would have hit deny-by-default if no other rule caught it.
    { id: "allow-setting", tool: "setting", decision: "allow", reason: "Agent settings flip (toggles, theme, provider — runtime state user can also change via UI)", priority: 50 },

    // Skills
    { id: "allow-skills", tool: "skill_*", decision: "allow", reason: "User-defined skill workflows", priority: 50 },

    // Playbook (legacy)
    { id: "allow-playbook", tool: "playbook_*", decision: "allow", reason: "Legacy playbook tools", priority: 50 },

    // ── Everything else is DENIED by default ──
    // No catch-all "allow *" rule. Unknown tools are blocked.
  ],
};
