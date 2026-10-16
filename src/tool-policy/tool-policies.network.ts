// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Network (browser/http/web), external services (Gmail / Calendar /
// Marketplace), and database tools.

import type { ToolPolicyRow } from "./tool-policies.types.js";

export const TOOL_POLICIES_NETWORK: Record<string, ToolPolicyRow> = {
  // ── Network ──
  browser: {
    // No count-based rate limit: a browser session legitimately fires many
    // actions in a burst (an element-dense page needs dozens of clicks/reads).
    // A hard throughput block dead-stops that. Instead the browser tool paces
    // bursts at the mutex (src/browser/mutex.ts) and stops genuine stuck-loops
    // via no-progress detection (src/browser/progress-tracker.ts), which feeds
    // the circuit breaker. The per-session ceiling below stays as a backstop.
    // Its kernel writes leave out `emulate`: that re-opens the current URL in
    // a new context, an http GET, and as a write it would be denied under web
    // taint — exactly after browsing, the only time a mobile re-render is wanted.
    kernel: "http", ariAction: { arg: "action", writes: ["click", "fill", "select", "type", "evaluate", "act"], as: "post" }, risk: "network-read", capabilities: ["egress"], timeoutMs: 30_000, liveState: "poll", externalContent: true, destination: [{ to: "browser-page" }],
    rules: [
      { id: "flag-browser-evaluate", action: "evaluate", decision: "allow", reason: "Browser JS evaluation — autonomous by default (guarded by CSP, sensitive-page gating at the browser-tool layer, and the read-into-context blocklist — not a per-call modal). Rule kept so the supervised-mode layer can re-arm a confirm.", priority: 100 },
      // No per-action rule for `emulate`: it falls to allow-browser below
      // (which matches every action), which is the intended decision. emulate
      // only re-opens the CURRENT url in an isolated context — it does not
      // warrant a per-call modal, and it is already gated where it matters
      // (in-app refusal, ownership refusal, sensitive-page approval,
      // human-verification block).
      { id: "allow-browser", decision: "allow", reason: "Browser allowed (paced + no-progress guarded)", priority: 40, constraints: { maxCallsPerSession: 100 } },
    ],
  },
  // Capture is the INGEST direction: page → vault, model-blind, zero egress. The
  // value is read server-side and written straight to the encrypted vault; the
  // tool result carries only {name, service, length}. That is a local write, not a
  // credential-exposure risk, so it is "workspace-write" (auto-allowed like any
  // local write) rather than "secrets" (which gates the exfiltration-capable
  // fill_from_secret / request_secret). A name that already exists is refused
  // inside the tool (the model never overwrites a record), not by a prompt.
  browser_capture_to_secret: { kernel: "secret-vault", ariAction: "capture", risk: "workspace-write", capabilities: [], rules: [{ id: "allow-browser-capture-to-secret", decision: "allow", reason: "Capture page value into encrypted vault (value never enters model context)", priority: 50 }] },
  browser_fill_from_secret:  { kernel: "secret-vault", ariAction: "fill", risk: "secrets", capabilities: [], rules: [{ id: "allow-browser-fill-from-secret", decision: "allow", reason: "Fill vault value into page input (origin-bound, selector-whitelisted, approval-gated)", priority: 50 }] },
  http_request: {
    kernel: "http", ariAction: { arg: "method", writes: ["POST", "PUT", "PATCH", "DELETE"] }, risk: "network-write", capabilities: ["egress"], timeoutMs: 60_000, output: "http-body", externalContent: true, offBoxFetch: true,
    destination: [{ to: "site", arg: "url", allowlisted: true }],
    rateLimit: { maxCalls: 20, windowMs: 60_000, action: "block" },
    rules: [{ id: "allow-http-limited", decision: "allow", reason: "HTTP allowed (rate limited, SSRF-checked, content-wrapped)", priority: 40, constraints: { maxCallsPerSession: 60 } }],
  },
  ari_http: { kernel: "internal", risk: "network-write", capabilities: ["egress"], output: "http-body", externalContent: true, offBoxFetch: true, destination: [{ to: "site", arg: "url", allowlisted: true }] },
  web_fetch: {
    kernel: "http", ariAction: "get", risk: "network-read", capabilities: ["egress"], timeoutMs: 60_000, output: "http-body", externalContent: true, offBoxFetch: true,
    destination: [{ to: "site", arg: "url" }],
    rateLimit: { maxCalls: 20, windowMs: 60_000, action: "block" },
    rules: [{ id: "allow-webfetch-limited", decision: "allow", reason: "Web fetch allowed (rate limited, SSRF-checked, content-wrapped)", priority: 40, constraints: { maxCallsPerSession: 60 } }],
  },
  compare_pages: {
    kernel: "http", ariAction: "get", risk: "network-read", capabilities: ["egress"], externalContent: true, offBoxFetch: true,
    rateLimit: { maxCalls: 20, windowMs: 60_000, action: "block" },
    rules: [{ id: "allow-compare-pages", decision: "allow", reason: "Structural two-page compare (read-only, rate limited, SSRF-checked, content-wrapped)", priority: 40, constraints: { maxCallsPerSession: 60 } }],
  },
  // Both ship the model's query off-box and read what comes back: the same
  // tier as web_fetch, not the local-read tier.
  web_search:          { kernel: "http", ariAction: "get", risk: "network-read", capabilities: ["egress"], timeoutMs: 15_000, externalContent: true, offBoxFetch: true, destination: [{ to: "service", name: "the web search engine" }], rules: [{ id: "allow-web-search", decision: "allow", reason: "Web search", priority: 50 }] },
  image_search:        { kernel: "http", ariAction: "get", risk: "network-read", capabilities: ["egress"], externalContent: true, offBoxFetch: true, destination: [{ to: "service", name: "the web search engine" }], rules: [{ id: "allow-image-search", decision: "allow", reason: "Web image search (read-only)", priority: 50 }] },
  youtube_analyze:     { kernel: "http", ariAction: "get", risk: "network-read", capabilities: ["egress"], externalContent: true, offBoxFetch: true, destination: [{ to: "site", arg: "url" }] },
  // Downloads land on disk under output_dir, which the tool confines to the
  // workspace itself (asset-tools.ts workspaceOutputDir); declared here too so
  // the file-access mode's write rules and the control-file gate see it.
  extract_site_assets: { kernel: "http", ariAction: "get", risk: "workspace-write", capabilities: ["egress"], externalContent: true, destination: [{ to: "site", arg: "url" }], pathArgs: [{ arg: "output_dir", action: "write" }], rules: [{ id: "allow-extract-site-assets", decision: "allow", reason: "Web asset extraction (downloads into the workspace)", priority: 50 }] },

  // ── External services (Gmail / Calendar / Marketplace) ──
  email_read:                  { kernel: "http", ariAction: "get", risk: "network-read", capabilities: ["sensitive-read"], output: "mailbox", externalContent: true },
  email_search:                { kernel: "http", ariAction: "get", risk: "network-read", capabilities: ["sensitive-read"], output: "mailbox", externalContent: true },
  // One message in full (IMAP FETCH) and the mailbox list (IMAP LIST). Both are
  // reads over the same transport as email_read/email_search and carry the same
  // risk class — neither writes, sends, or takes a path argument.
  email_read_message:          { kernel: "http", ariAction: "get", risk: "network-read", capabilities: ["sensitive-read"], output: "mailbox", externalContent: true },
  email_folders:               { kernel: "http", ariAction: "get", risk: "network-read", capabilities: [], externalContent: true },
  // email_delete is the canonical destructive class (delete_file, memory_forget,
  // process_kill) and that is what wires the autonomy gating: profiles.ts maps
  // it to deny / ask / allow-with-rollback per profile. It can carry that class
  // HONESTLY only because the operation is a move to Trash — reversible by
  // construction — since rollback.ts has no mailbox-shaped undo to offer.
  // email_mark changes IMAP flags: a real, user-visible mutation, but a
  // recoverable one, so it sits with the other workspace writes rather than
  // being dressed up as either a read or a destructive act.
  // Both kernel actions are WRITE verbs on purpose: the kernel preset denies
  // them under email/web taint, so a turn that has read third-party mail
  // cannot then trash or re-flag it — the shape of an injected "delete all my
  // email". Mapping either to "get" would be lying to the kernel.
  email_delete:                { kernel: "http", ariAction: "delete", risk: "destructive", capabilities: [], externalContent: true, undo: { recoverable: "moves the message to the mailbox's Trash — never an expunge (email-imap decision E1)" } },
  email_mark:                  { kernel: "http", ariAction: "post", risk: "workspace-write", capabilities: [], externalContent: true },
  email_draft:                 { kernel: "http", ariAction: "post", risk: "workspace-write", capabilities: [] },
  // email_setup's verify step connects to the model-named SMTP host with the
  // vault password: an off-box sink. email_send attaches local files by path.
  email_setup:                 { kernel: "http", ariAction: "post", risk: "workspace-write", capabilities: ["egress"], offBoxFetch: true },
  email_send:                  { kernel: "http", ariAction: "post", risk: "external-comms", capabilities: ["egress"], destination: [{ to: "recipients", args: ["to", "cc", "bcc"] }], pathArgs: [{ arg: "attachments", action: "read", json: true }] },
  telegram_send:               { kernel: "http", ariAction: "post", risk: "external-comms", capabilities: ["egress"], offBoxFetch: true, destination: [{ to: "chat", app: "Telegram", arg: "chat_id" }], rules: [{ id: "allow-telegram-send", decision: "allow", reason: "Proactive owner DM over the Telegram bridge (egress-gated, confined to authorized chats)", priority: 50 }] },
  whatsapp_send:               { kernel: "http", ariAction: "post", risk: "external-comms", capabilities: ["egress"], offBoxFetch: true, destination: [{ to: "chat", app: "WhatsApp", arg: "phone" }], rules: [{ id: "allow-whatsapp-send", decision: "allow", reason: "Proactive owner DM over the WhatsApp bridge (egress-gated, confined to authorized numbers)", priority: 50 }] },
  // The calendar is the local calendar.json in the data dir (calendar-tools.ts):
  // nothing leaves the box and no third party sees an event, so the reads are
  // "safe" and a create is a local write.
  calendar_check_availability: { kernel: "http", ariAction: "get", risk: "safe", capabilities: [] },
  calendar_list_events:        { kernel: "http", ariAction: "get", risk: "safe", capabilities: [] },
  calendar_create_event:       { kernel: "http", ariAction: "post", risk: "workspace-write", capabilities: [] },
  marketplace_search:          { kernel: "http", ariAction: "get", risk: "network-read", capabilities: [] },
  marketplace_list:            { kernel: "http", ariAction: "get", risk: "network-read", capabilities: [] },
  marketplace_install:         { kernel: "http", ariAction: "get", risk: "destructive", capabilities: [], undo: { irreversible: "overwrites a custom protocol record" } },

  // ── Database ──
  sql_query:           { kernel: "database", ariAction: "query", risk: "workspace-write", capabilities: ["sensitive-read"] },
  sql_explain:         { kernel: "database", ariAction: "query", risk: "safe", capabilities: [] },
  sql_schema:          { kernel: "database", ariAction: "query", risk: "safe", capabilities: [] },
  ari_database:        { kernel: "internal", risk: "workspace-write", capabilities: ["sensitive-read"], liveState: "fresh" },
  ari_sqlite:          { kernel: "internal", risk: "workspace-write", capabilities: ["sensitive-read"] },

};
