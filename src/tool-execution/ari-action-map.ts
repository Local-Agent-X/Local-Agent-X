// Kernel action derivation — the (tool → AriKernel action) mapping the policy
// phase feeds into ariEvaluate. Split out of enforce-policy.ts (SC-10) so that
// file stays under the source-hygiene LOC ceiling; the canonical owner of this
// table. Re-exported from ./enforce-policy.js so existing importers are
// unaffected.

// HOST_CAPABILITY_MANIFEST action names — see ari-kernel.ts. A non-shell
// tool that falls through to "exec" → lookupHostGrantId returns undefined
// → firewall.execute throws → ariRequired turns it into a block. Every
// gated tool must map to a manifest-valid action. Exported for the
// coverage test (ari-action-map.test.ts) that fails when a kernel-gated
// tool ships without a mapping — image_search did exactly that
// (2026-06-10): action fell through to "exec", the http schema rejected
// it, and every call blocked as "ARI error (ariRequired mode)".
export const ARI_ACTION_MAP: Record<string, string> = {
  read: "read", write: "write", edit: "write", edit_lines: "write", multi_edit: "write", bulk_replace: "write",
  web_search: "get", web_fetch: "get", http_request: "get", browser: "get",
  image_search: "get",
  bash: "exec",
  memory_search: "search",
  // ARI database toolClass declares actions [query, exec, mutate] — "write"
  // is not in that set, so action="write" tripped deny-by-default at the
  // policy engine. memory_save is a row insert into the daily-log SQLite
  // table, which maps cleanly to mutate.
  memory_save: "mutate",
  // secret-vault actions are overridden inside ariEvaluate by
  // secretVaultActionMap; "capture" is just a valid no-op default.
  browser_capture_to_secret: "capture",
  browser_fill_from_secret: "fill",
  clipboard_write_from_secret: "clipboard",
  // file
  glob: "read", grep: "read", view_image: "read", send_video: "read", send_image: "read", delete_file: "write",
  // http — get for read paths, post for mutations
  calendar_check_availability: "get", calendar_list_events: "get",
  calendar_create_event: "post",
  email_read: "get", email_search: "get", email_draft: "post",
  email_send: "post", email_setup: "post", telegram_send: "post", whatsapp_send: "post",
  marketplace_search: "get", marketplace_list: "get", marketplace_install: "get",
  extract_site_assets: "get",
  youtube_analyze: "get",
  // shell — subprocess spawns + OS process queries
  process_start: "exec", process_status: "exec",
  process_kill: "exec", process_list: "exec",
  // database — SQL (read-class today; tools self-restrict writes)
  sql_query: "query", sql_explain: "query", sql_schema: "query",
  // retrieval — vector/keyword session search
  search_past_sessions: "search",
};

// The static map above is per-tool-NAME, so http_request and browser always
// read as "get" — a POST or a browser click/evaluate looks passive to the
// kernel, and a preset that denies http WRITES can never see them. deriveAriAction
// derives the kernel action from the CALL's args instead:
//   http_request → by args.method (POST/PUT/PATCH/DELETE → that write verb;
//                  GET/HEAD/OPTIONS/absent → "get")
//   browser      → by args.action (click/fill/select/type/evaluate/act → "post"
//                  = an http write; navigate/read/screenshot/absent → "get")
// Verified against the real arikernel workspace-assistant preset
// (packages/arikernel/core/src/presets/policy-spec.json): allow-http-write-clean
// (prio 100) allows a CLEAN post/put/patch/delete, deny-tainted-http-write
// (prio 40, wins) denies the SAME verbs under web/rag/email taint — so a clean
// POST stays allowed and only a tainted POST is denied; all four verbs are valid
// http actions in HOST_CAPABILITY_MANIFEST. Tools whose action isn't derivable
// from args fall through to the static ARI_ACTION_MAP.
const HTTP_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BROWSER_WRITE_ACTIONS = new Set(["click", "fill", "select", "type", "evaluate", "act"]);

export function deriveAriAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "http_request") {
    const method = String(args?.method ?? "GET").toUpperCase();
    return HTTP_WRITE_METHODS.has(method) ? method.toLowerCase() : "get";
  }
  if (toolName === "browser") {
    const action = String(args?.action ?? "").toLowerCase();
    return BROWSER_WRITE_ACTIONS.has(action) ? "post" : "get";
  }
  return ARI_ACTION_MAP[toolName] || "exec";
}
