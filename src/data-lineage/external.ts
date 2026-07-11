/**
 * Data Lineage — per-session EXTERNAL-CONTENT ingestion registry.
 *
 * Sibling of the sensitive-read taint registry (taint.ts), but
 * for the OTHER trust axis. That registry answers "did this session touch OUR
 * secrets?" and gates EGRESS. This one answers "did this session ingest
 * UNTRUSTED off-box content (web fetch / http / browser / search / MCP)?" and
 * gates DURABLE MEMORY PROMOTION: a turn that saw external content must not
 * auto-promote to USER.md / the Facts DB, because an LLM paraphrase of
 * injected material erases every content-based taint marker checkMemoryTaint
 * could catch (decision D6 — enforcement only; explicit remember/memory_save
 * tool calls stay allowed, they are already gated + provenance-marked).
 * It is a COMPLEMENTARY signal UNDER the capability-based promotion gate
 * (promotion-gate.ts), which stays primary: consumers are the auto-extract
 * pre-flight skip and the approval phase's downgrade of trusted-user-evidence
 * promotions to require interactive approval.
 *
 * Detection is TOOL-CLASS based (D8), not content-sniffing: a SUCCESSFUL
 * result from an off-box-ingesting tool marks the session (hook in
 * run-sandboxed.ts). Sniffing the wrapExternalContent boundary in result
 * bodies was rejected — it missed unwrapped browser paths (observe /
 * evaluate / post-action snapshots return raw page text) and false-positived
 * when a session merely READ a file containing the boundary literal (this
 * repo's own sanitize.ts), permanently self-tainting dev sessions.
 *
 * Deliberately NOT recordSensitiveRead(source:"web"): inbound web bytes are
 * untrusted, not secret — tainting them for egress would brick outbound tools
 * after any routine fetch (run-sandboxed.ts explicitly does not taint on
 * web_fetch/http_request for exactly that reason).
 *
 * Lifecycle mirrors sessionTaint: in-memory, STICKY for the session's life
 * (the model can't "un-see" injected instructions; no production caller
 * clears it — clearExternalIngestion exists for tests, like clearSessionTaint),
 * propagated parent←child alongside propagateTaint (handler-completion.ts).
 */

const externalIngestSessions = new Set<string>();

/**
 * Tools whose SUCCESSFUL results place off-box (untrusted external) content
 * into the model context. No existing classification is exactly this axis:
 * EGRESS_TOOLS (tool-registry.ts) includes non-ingesting exfil sinks
 * (email_send, clipboard_write, process_start, send_image, computer, ...) and
 * the policy `offBoxFetch` flag marks payload-ships-off-box tools
 * (view_image, generate_image, telegram_send) whose results are not external
 * content. Membership here is the INGESTION subset of the egress class:
 *  - web_fetch / http_request / ari_http — fetched bodies
 *  - browser — ALL actions: even a bare navigate ingests the page via any
 *    subsequent read/snapshot/observe result, wrapped or not
 *  - web_search / image_search — off-box result snippets enter context
 *  - extract_site_assets / youtube_analyze — off-box GET returning content
 *  - email_read / email_search — third-party-authored sender/subject/body
 *    content over IMAP (email-read-tools.ts), returned with NO wrap; inbound
 *    email is a primary injection channel
 * Local file reads and sql over local DBs are deliberately NOT here (owned
 * sources — covered by the sensitive-read taint axis instead).
 */
const EXTERNAL_INGESTING_TOOLS: ReadonlySet<string> = new Set([
	"web_fetch",
	"http_request",
	"ari_http",
	"browser",
	"web_search",
	"image_search",
	"extract_site_assets",
	"youtube_analyze",
	"email_read",
	"email_search",
]);

/** Built-in LOCAL management tools that happen to carry the mcp_ prefix
 *  (mcp-admin-tools.ts — currently just mcp_add_server, which writes
 *  ~/.lax/mcp.json and spawns the server). They ingest nothing off-box, so
 *  they must not false-mark the session via the prefix rule below. */
const MCP_BUILTIN_LOCAL_TOOLS: ReadonlySet<string> = new Set([
	"mcp_add_server",
]);

/** Does a successful result from this tool constitute external-content
 *  ingestion? MCP server tools (mcp_<server>_<tool>, registered at runtime)
 *  are all external per the campaign's trust model — their results come from
 *  an out-of-process server this system doesn't own. Built-in local mcp_*
 *  management tools are exclusion-listed before the prefix check. */
export function isExternalIngestingTool(toolName: string): boolean {
	if (MCP_BUILTIN_LOCAL_TOOLS.has(toolName)) return false;
	return EXTERNAL_INGESTING_TOOLS.has(toolName) || toolName.startsWith("mcp_");
}

/** Mark the session as having ingested external (untrusted) content. */
export function recordExternalIngestion(sessionId: string): void {
	if (!sessionId) return;
	externalIngestSessions.add(sessionId);
}

/** Has this session ingested external content? STICKY for the session's life. */
export function hasExternalIngestion(sessionId: string): boolean {
	return externalIngestSessions.has(sessionId);
}

/** Clear the mark — test hook, the silent counterpart of clearSessionTaint.
 *  No production caller: the mark lives exactly as long as the session. */
export function clearExternalIngestion(sessionId: string): void {
	externalIngestSessions.delete(sessionId);
}

/**
 * Propagate the mark from a child (sub-agent) session to its parent, mirroring
 * propagateTaint: a sub-agent's fetched content flows back in its result, so
 * the parent's persist path must see the same block. Returns true when a mark
 * was propagated (for logging / tests). No-op when the child is clean.
 */
export function propagateExternalIngestion(fromSessionId: string, toSessionId: string): boolean {
	if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return false;
	if (!externalIngestSessions.has(fromSessionId)) return false;
	externalIngestSessions.add(toSessionId);
	return true;
}
