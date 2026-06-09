// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Network (browser/http/web), external services (Gmail / Calendar /
// Marketplace), and database tools.

import type { ToolPolicyEntry } from "./tool-policies.types.js";

export const TOOL_POLICIES_NETWORK: Record<string, ToolPolicyEntry> = {
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
  web_search:          { kernel: "http", risk: "safe", offBoxFetch: true, rules: [{ id: "allow-web-search", decision: "allow", reason: "Web search", priority: 50 }] },
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
  ari_sqlite:          { kernel: "internal", risk: "workspace-write" },

};
