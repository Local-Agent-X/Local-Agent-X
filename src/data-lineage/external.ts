/**
 * Data Lineage — per-session EXTERNAL-CONTENT ingestion registry.
 *
 * Sibling of the sensitive-read taint registry (taint.ts), but
 * for the OTHER trust axis. That registry answers "did this session touch OUR
 * secrets?" and gates EGRESS. This one answers "did this session ingest
 * UNTRUSTED off-box content (web fetch / http / browser / search / MCP)?" and
 * gates DURABLE MEMORY PROMOTION (decision D6): an LLM paraphrase of injected
 * material erases every content-based taint marker checkMemoryTaint could
 * catch, so the session mark is what a promotion path has to reason from.
 * It is a COMPLEMENTARY signal UNDER the capability-based promotion gate
 * (promotion-gate.ts), which stays primary. Consumers: the auto-extract gate
 * (per-fact, see externalContentVerdict), the end-of-turn profile pass's
 * decline, and the approval phase's downgrade of trusted-user-evidence
 * promotions to interactive approval. Explicit remember/memory_save tool calls
 * stay allowed — gated + provenance-marked.
 *
 * Detection is TOOL-CLASS based (D8), not content-sniffing: a SUCCESSFUL
 * result from an off-box-ingesting tool marks the session (hook in
 * run-sandboxed.ts). Sniffing the wrapExternalContent boundary in result
 * bodies was rejected — it missed unwrapped browser paths (observe /
 * evaluate / post-action snapshots return raw page text) and false-positived
 * when a session merely READ a file containing the boundary literal (this
 * repo's own sanitize.ts), permanently self-tainting dev sessions.
 *
 * The mark also carries CONTENT FINGERPRINTS of what was delivered (the same
 * shingle hashes the sensitive-read registry keeps; no plaintext is stored) so
 * a promotion path can ask the narrower question the boolean cannot: do THESE
 * bytes come from the external content? Blocking every fact from a session
 * that touched the web was measured as unusable — an evening of browsing-led
 * setup work left no durable memory at all — so the gate is now per fact:
 * a fact that overlaps the delivered content is refused, one that provably
 * does not is saved with a provenance mark, and one we cannot adjudicate
 * (content never captured, or too long to fully cover) is skipped as before.
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

import { createHash } from "node:crypto";
import { type TaintEntry, MAX_FINGERPRINT_CONTENT, computeFingerprints, payloadFingerprints } from "./fingerprint.js";
import { adjudicatePayload, type PayloadVerdict } from "./payload-overlap.js";

interface ExternalIngestState {
	entries: TaintEntry[];
	/** sha256 of each recorded content — a re-read of the same page adds nothing. */
	seen: Set<string>;
	/** Fingerprints held so far, against EXTERNAL_HASH_BUDGET. */
	hashes: number;
}

// Per-session ceiling on stored fingerprints (~50 bytes each in V8 → ≤ ~26MB
// for a session that reads hundreds of full-size pages). Past it, further
// content is recorded content-LESS: the session stays marked and every later
// verdict is "unknowable" — the pre-fingerprint behavior — rather than an
// unbounded map.
const EXTERNAL_HASH_BUDGET = 1 << 19;

const externalIngestSessions = new Map<string, ExternalIngestState>();

function stateFor(sessionId: string): ExternalIngestState {
	let state = externalIngestSessions.get(sessionId);
	if (!state) {
		state = { entries: [], seen: new Set(), hashes: 0 };
		externalIngestSessions.set(sessionId, state);
	}
	return state;
}

function contentlessEntry(sessionId: string, target: string): TaintEntry {
	return { source: "web", target, timestamp: Date.now(), runId: sessionId, fingerprints: [], complete: false };
}

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

/**
 * Mark the session as having ingested external (untrusted) content, and
 * fingerprint what was DELIVERED so a later verdict can prove a fact free of
 * it. `content` is the delivered result text; `target` names the read for the
 * skip log. Without `content` the mark is content-less: the session is marked
 * and stays unknowable (the caller could not say what came in).
 *
 * A result too short to hold a single shingle window records only the mark:
 * nothing a fact could overlap exists in it, so it neither blocks nor makes
 * the session unknowable.
 */
export function recordExternalIngestion(sessionId: string, content?: string, target = "external"): void {
	if (!sessionId) return;
	const state = stateFor(sessionId);
	if (content === undefined) {
		state.entries.push(contentlessEntry(sessionId, target));
		return;
	}
	const fp = computeFingerprints(content, MAX_FINGERPRINT_CONTENT);
	if (fp.fingerprints.length === 0) return;
	const digest = createHash("sha256").update(content).digest("hex");
	if (state.seen.has(digest)) return;
	state.seen.add(digest);
	if (state.hashes + fp.fingerprints.length > EXTERNAL_HASH_BUDGET) {
		state.entries.push(contentlessEntry(sessionId, target));
		return;
	}
	state.hashes += fp.fingerprints.length;
	state.entries.push({
		source: "web",
		target,
		timestamp: Date.now(),
		runId: sessionId,
		fingerprints: fp.fingerprints,
		complete: fp.complete,
	});
}

/** Has this session ingested external content? STICKY for the session's life. */
export function hasExternalIngestion(sessionId: string): boolean {
	return externalIngestSessions.has(sessionId);
}

/**
 * Does `text` carry bytes from the external content this session ingested?
 * The memory-promotion twin of the browser/http write adjudicators
 * (tool-execution/taint-scope.ts) — the same verdict core over this
 * registry's entries:
 *  - a session that ingested nothing → "clean" (nothing to overlap);
 *  - text too short to hold a shingle window → "unknowable" (absence of
 *    evidence is not evidence of absence at that size);
 *  - otherwise adjudicatePayload: "overlap" names the reads whose bytes are
 *    in the text; "unknowable" means some ingested content was never captured
 *    or not fully covered; "clean" means every read is fully fingerprinted
 *    and none overlaps.
 */
export function externalContentVerdict(sessionId: string, text: string): PayloadVerdict {
	const state = externalIngestSessions.get(sessionId);
	if (!state) return { verdict: "clean", evidence: [] };
	if (payloadFingerprints(text).size === 0) return { verdict: "unknowable", evidence: [] };
	return adjudicatePayload(state.entries, text);
}

/** Clear the mark — test hook, the silent counterpart of clearSessionTaint.
 *  No production caller: the mark lives exactly as long as the session. */
export function clearExternalIngestion(sessionId: string): void {
	externalIngestSessions.delete(sessionId);
}

/**
 * Propagate the mark from a child (sub-agent) session to its parent, mirroring
 * propagateTaint: a sub-agent's fetched content flows back in its result, so
 * the parent's persist path must see the same block. The child's entries are
 * carried whole (fingerprints and completeness included) so the parent's
 * verdicts adjudicate the same bytes. Returns true when a mark was propagated
 * (for logging / tests). No-op when the child is clean.
 */
export function propagateExternalIngestion(fromSessionId: string, toSessionId: string): boolean {
	if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return false;
	const from = externalIngestSessions.get(fromSessionId);
	if (!from) return false;
	const to = stateFor(toSessionId);
	for (const entry of from.entries) {
		to.entries.push({ ...entry, timestamp: Date.now(), runId: toSessionId });
		to.hashes += entry.fingerprints.length;
	}
	for (const digest of from.seen) to.seen.add(digest);
	return true;
}
