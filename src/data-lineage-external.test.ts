/**
 * External-content ingestion registry (data-lineage-external.ts) + its
 * production hooks: the tool-class mark in runSandboxedPhase (D8) and the
 * parent←child propagation in pushCompletionToParent.
 *
 * Semantics under test: a SUCCESSFUL result from an off-box-ingesting tool
 * (web_fetch/http_request/browser/search/mcp_*) marks the session — by TOOL
 * CLASS, never by sniffing result bodies (a session reading a source file
 * that contains the wrap-boundary literal must NOT self-taint, and an
 * unwrapped browser observe must still mark). The mark is STICKY for the
 * session's life (mirrors the sensitive-read taint registry; cleared only by
 * the test hook) and propagates parent←child like propagateTaint. This is
 * the signal the memory persist path (PersistTurnInput.hasExternalTaint)
 * reads to block durable auto-promotion of turns that saw untrusted content
 * (D6), and the approval phase reads to downgrade trusted-user-evidence
 * promotions to interactive approval.
 */
import { describe, it, expect } from "vitest";
import {
	recordExternalIngestion,
	hasExternalIngestion,
	clearExternalIngestion,
	propagateExternalIngestion,
	isExternalIngestingTool,
} from "./data-lineage-external.js";
import { runSandboxedPhase } from "./tool-execution/run-sandboxed.js";
import type { ToolCallContext } from "./tool-execution/context.js";
import type { ToolDefinition } from "./types.js";
import { readTool } from "./tools/read-write-tools.js";
import { ok } from "./tools/result-helpers.js";
import { pushCompletionToParent } from "./agency/handler-completion.js";
import type { FieldAgent } from "./agency/handler-types.js";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

let seq = 0;
function freshSession(): string { return `ext-ingest-${seq++}`; }

describe("external-ingestion registry", () => {
	it("records and reports ingestion per session; unmarked sessions are clean", () => {
		const s = freshSession();
		expect(hasExternalIngestion(s)).toBe(false);
		recordExternalIngestion(s);
		expect(hasExternalIngestion(s)).toBe(true);
		expect(hasExternalIngestion(freshSession())).toBe(false);
		clearExternalIngestion(s);
	});

	it("is STICKY: repeated checks never decay the mark (no TTL)", () => {
		const s = freshSession();
		recordExternalIngestion(s);
		for (let i = 0; i < 3; i++) expect(hasExternalIngestion(s)).toBe(true);
		clearExternalIngestion(s);
	});

	it("clearExternalIngestion (test hook — no production caller) resets the session", () => {
		const s = freshSession();
		recordExternalIngestion(s);
		clearExternalIngestion(s);
		expect(hasExternalIngestion(s)).toBe(false);
	});

	it("ignores an empty sessionId", () => {
		recordExternalIngestion("");
		expect(hasExternalIngestion("")).toBe(false);
	});

	it("propagates child → parent like propagateTaint; clean child is a no-op", () => {
		const parent = freshSession();
		const child = freshSession();
		expect(propagateExternalIngestion(child, parent)).toBe(false);
		expect(hasExternalIngestion(parent)).toBe(false);
		recordExternalIngestion(child);
		expect(propagateExternalIngestion(child, parent)).toBe(true);
		expect(hasExternalIngestion(parent)).toBe(true);
		clearExternalIngestion(parent);
		clearExternalIngestion(child);
	});
});

describe("isExternalIngestingTool — tool-class membership (D8)", () => {
	it("covers the off-box ingestion class incl. ALL browser actions, inbound email, and mcp_*", () => {
		for (const name of ["web_fetch", "http_request", "ari_http", "browser", "web_search", "image_search", "extract_site_assets", "youtube_analyze", "email_read", "email_search", "mcp_github_search_issues"]) {
			expect(isExternalIngestingTool(name), name).toBe(true);
		}
	});
	it("excludes local reads, sql over local DBs, and non-ingesting egress sinks", () => {
		for (const name of ["read", "grep", "glob", "sql_query", "bash", "email_send", "clipboard_write", "write", "memory_search"]) {
			expect(isExternalIngestingTool(name), name).toBe(false);
		}
	});
	it("excludes built-in LOCAL mcp_* management tools despite the prefix (mcp_add_server ingests nothing)", () => {
		expect(isExternalIngestingTool("mcp_add_server")).toBe(false);
	});
});

// ── runSandboxedPhase hook ───────────────────────────────────────────────────

function fakeTool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
	return {
		name,
		description: "test tool",
		parameters: { type: "object", properties: {} },
		execute,
	} as unknown as ToolDefinition;
}

function ctxFor(tool: ToolDefinition, args: Record<string, unknown>, sessionId: string): ToolCallContext {
	return {
		tc: { id: "tc1", name: tool.name, arguments: JSON.stringify(args) },
		toolMap: new Map([[tool.name, tool]]),
		tool,
		args,
		sessionId,
		callContext: "local",
		riskLevel: "low",
		approvalContext: "",
		allowed: true,
		msgs: [],
	} as unknown as ToolCallContext;
}

describe("runSandboxedPhase — external-content ingestion hook (tool-class, D8)", () => {
	it("a successful browser result marks the session — even observe-only, UNWRAPPED page text", async () => {
		const s = freshSession();
		// Mimics browser observe/snapshot paths that return raw page text with
		// no wrapExternalContent boundary (observe.ts, page-ops evaluate,
		// post-action snapshots) — the miss that sank content-sniffing.
		const tool = fakeTool("browser", async () => ok("heading: Welcome\nlink: Sign in"));
		await runSandboxedPhase(ctxFor(tool, { action: "observe" }, s));
		expect(hasExternalIngestion(s)).toBe(true);
		clearExternalIngestion(s);
	});

	it("a successful email_read result marks the session — inbound mail is third-party-authored, unwrapped", async () => {
		const s = freshSession();
		const tool = fakeTool("email_read", async () =>
			ok("From: sender@example.com\nSubject: Invoice\nSnippet: please review the attached"),
		);
		await runSandboxedPhase(ctxFor(tool, { id: "42" }, s));
		expect(hasExternalIngestion(s)).toBe(true);
		clearExternalIngestion(s);
	});

	it("a successful mcp_* result marks the session", async () => {
		const s = freshSession();
		const tool = fakeTool("mcp_files_list_remote", async () => ok("remote listing"));
		await runSandboxedPhase(ctxFor(tool, {}, s));
		expect(hasExternalIngestion(s)).toBe(true);
		clearExternalIngestion(s);
	});

	it("READING a file that contains the wrap-boundary literal does NOT mark the session (no content sniffing)", async () => {
		const s = freshSession();
		// src/sanitize.ts contains the literal `<<<EXTERNAL_UNTRUSTED_CONTENT`
		// wrap boundary — under content-sniffing, any dev session on this repo
		// self-tainted and silently lost memory auto-promotion for life.
		const sanitizePath = join(dirname(fileURLToPath(import.meta.url)), "sanitize.ts");
		const ctx = ctxFor(readTool, { path: sanitizePath }, s);
		await runSandboxedPhase(ctx);
		expect(ctx.result!.isError).toBeFalsy();
		expect(ctx.result!.content).toContain("EXTERNAL_UNTRUSTED_CONTENT");
		expect(hasExternalIngestion(s)).toBe(false);
	});

	it("an errored result from an ingesting tool does NOT mark the session", async () => {
		const s = freshSession();
		const tool = fakeTool("web_fetch", async () => ({ content: "fetch failed: ECONNREFUSED", isError: true }));
		await runSandboxedPhase(ctxFor(tool, {}, s));
		expect(hasExternalIngestion(s)).toBe(false);
	});
});

// ── parent←child propagation wiring (handler-completion.ts) ─────────────────

describe("pushCompletionToParent — external-ingestion propagation wiring", () => {
	it("child fetched off-box content → parent session is marked (persistTurn will see hasExternalTaint=true)", async () => {
		const parent = freshSession();
		const child = freshSession();
		// The child's web_fetch marked its own (runSessionId) bucket during the run.
		const tool = fakeTool("web_fetch", async () => ok("page body"));
		await runSandboxedPhase(ctxFor(tool, {}, child));
		expect(hasExternalIngestion(child)).toBe(true);
		expect(hasExternalIngestion(parent)).toBe(false);

		const agent = {
			id: "agt-1",
			name: "researcher",
			parentSessionId: parent,
			runSessionId: child,
			output: [],
			startedAt: Date.now(),
			tokensUsed: 0,
			messageQueue: [],
		} as unknown as FieldAgent;
		pushCompletionToParent(agent, "succeeded", "done");

		// This is the exact predicate canonical-run.ts:persistTurnState evaluates
		// to set PersistTurnInput.hasExternalTaint on the parent's next persist.
		expect(hasExternalIngestion(parent)).toBe(true);
		clearExternalIngestion(parent);
		clearExternalIngestion(child);
	});

	it("clean child completion does not mark the parent", () => {
		const parent = freshSession();
		const agent = {
			id: "agt-2",
			name: "worker",
			parentSessionId: parent,
			runSessionId: freshSession(),
			output: [],
			startedAt: Date.now(),
			tokensUsed: 0,
			messageQueue: [],
		} as unknown as FieldAgent;
		pushCompletionToParent(agent, "succeeded", "done");
		expect(hasExternalIngestion(parent)).toBe(false);
	});
});
