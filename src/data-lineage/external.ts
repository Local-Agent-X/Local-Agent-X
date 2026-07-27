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
 *  - WebSearch / WebFetch — provider-native aliases observed out of process
 *  - extract_site_assets / youtube_analyze — off-box GET returning content
 *  - email_read / email_search — third-party-authored sender/subject/body
 *    content over IMAP (email-read-tools.ts), returned with NO wrap; inbound
 *    email is a primary injection channel
 *  - email_read_message — the LARGEST untrusted surface of any email tool: its
 *    siblings return a snippet, this returns one message's whole body plus
 *    attachment filenames, all authored by whoever sent the mail, all unwrapped.
 *    Absent from this set, that body escapes the axis entirely and a turn that
 *    read it could auto-promote an LLM paraphrase of injected instructions
 *    straight into USER.md / the Facts DB — the exact D6 failure.
 *  - email_folders — folder PATHS and names, which are strings chosen by the
 *    IMAP server or by anyone who can create a folder in the mailbox (a shared
 *    or delegated account, a hostile/compromised server). Small, but this
 *    registry is TOOL-CLASS keyed (D8), not payload-volume keyed — `browser` is
 *    enrolled for a bare navigate on the same reasoning — and every byte of the
 *    result is off-box-authored text the model reads verbatim. The only cost of
 *    membership is that the turn cannot AUTO-promote durable memory, which a
 *    turn that just walked a third-party mailbox should not be doing; explicit
 *    remember/memory_save stays allowed and provenance-marked.
 *  - email_delete / email_mark — enrolled for the SAME reason as email_folders,
 *    not a weaker one. Their results deliberately carry no message content
 *    (counts, uids and folder paths only), but a folder path IS off-box-authored
 *    text: email_delete echoes the Trash folder's server-chosen path back into
 *    context on every call, and both echo the server's own spelling of the
 *    source folder. Leaving them out would make the axis depend on a payload
 *    decision inside a tool file rather than on the tool's class — precisely the
 *    coupling D8 rejected — so a later change that added a subject line to a
 *    delete confirmation would silently escape the axis. The cost is one
 *    session's memory AUTO-promotion, and a turn that just deleted mail on a
 *    third party's instruction is the last turn that should be writing durable
 *    facts.
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
	"email_read_message",
	"email_folders",
	"email_delete",
	"email_mark",
	"WebSearch",
	"WebFetch",
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
