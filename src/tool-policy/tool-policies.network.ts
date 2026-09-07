// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Network (browser/http/web), external services (Gmail / Calendar /
// Marketplace), and database tools.

import type { ToolPolicyEntry } from "./tool-policies.types.js";

export const TOOL_POLICIES_NETWORK: Record<string, ToolPolicyEntry> = {
  // ── Network ──
  browser: {
    // No count-based rate limit: a browser session legitimately fires many
    // actions in a burst (an element-dense page needs dozens of clicks/reads).
    // A hard throughput block dead-stops that. Instead the browser tool paces
    // bursts at the mutex (src/browser/mutex.ts) and stops genuine stuck-loops
    // via no-progress detection (src/browser/progress-tracker.ts), which feeds
    // the circuit breaker. The per-session ceiling below stays as a backstop.
    kernel: "http", risk: "network-read",
    rules: [
      { id: "flag-browser-evaluate", action: "evaluate", decision: "allow", reason: "Browser JS evaluation — autonomous by default (guarded by CSP, sensitive-page gating at the browser-tool layer, and the read-into-context blocklist — not a per-call modal). Rule kept so the supervised-mode layer can re-arm a confirm.", priority: 100 },
      { id: "allow-browser", decision: "allow", reason: "Browser allowed (paced + no-progress guarded)", priority: 40, constraints: { maxCallsPerSession: 100 } },
    ],
  },
  // Capture is the INGEST direction: page → vault, model-blind, zero egress. The
  // value is read server-side and written straight to the encrypted vault; the
  // tool result carries only {name, service, length}. That is a local write, not a
  // credential-exposure risk, so it is "workspace-write" (auto-allowed like any
  // local write) rather than "secrets" (which gates the exfiltration-capable
  // fill_from_secret / request_secret). Overwrite integrity is guarded inside the
  // tool (confirm only when the name already exists), not by a blanket prompt.
  browser_capture_to_secret: { kernel: "secret-vault", risk: "workspace-write", rules: [{ id: "allow-browser-capture-to-secret", decision: "allow", reason: "Capture page value into encrypted vault (value never enters model context)", priority: 50 }] },
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
  image_search:        { kernel: "http", risk: "safe", offBoxFetch: true, rules: [{ id: "allow-image-search", decision: "allow", reason: "Web image search (read-only)", priority: 50 }] },
  youtube_analyze:     { kernel: "http", risk: "network-read" },
  extract_site_assets: { kernel: "http", risk: "network-read", rules: [{ id: "allow-extract-site-assets", decision: "allow", reason: "Web asset extraction (read-only)", priority: 50 }] },

  // ── External services (Gmail / Calendar / Marketplace) ──
  email_read:                  { kernel: "http", risk: "network-read" },
  email_search:                { kernel: "http", risk: "network-read" },
  // One message in full (IMAP FETCH) and the mailbox list (IMAP LIST). Both are
  // reads over the same transport as email_read/email_search and carry the same
  // risk class — neither writes, sends, or takes a path argument.
  email_read_message:          { kernel: "http", risk: "network-read" },
  email_folders:               { kernel: "http", risk: "network-read" },
  // email_delete is the canonical destructive class (delete_file, memory_forget,
  // process_kill) and that is what wires the autonomy gating: profiles.ts maps
  // it to deny / ask / allow-with-rollback per profile. It can carry that class
  // HONESTLY only because the operation is a move to Trash — reversible by
  // construction — since rollback.ts has no mailbox-shaped undo to offer.
  // email_mark changes IMAP flags: a real, user-visible mutation, but a
  // recoverable one, so it sits with the other workspace writes rather than
  // being dressed up as either a read or a destructive act.
  email_delete:                { kernel: "http", risk: "destructive" },
  email_mark:                  { kernel: "http", risk: "workspace-write" },
  email_draft:                 { kernel: "http", risk: "workspace-write" },
  email_setup:                 { kernel: "http", risk: "workspace-write" },
  email_send:                  { kernel: "http", risk: "external-comms" },
  telegram_send:               { kernel: "http", risk: "external-comms", offBoxFetch: true, rules: [{ id: "allow-telegram-send", decision: "allow", reason: "Proactive owner DM over the Telegram bridge (egress-gated, confined to authorized chats)", priority: 50 }] },
  whatsapp_send:               { kernel: "http", risk: "external-comms", offBoxFetch: true, rules: [{ id: "allow-whatsapp-send", decision: "allow", reason: "Proactive owner DM over the WhatsApp bridge (egress-gated, confined to authorized numbers)", priority: 50 }] },
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
