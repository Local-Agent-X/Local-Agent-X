/**
 * Task-artifact registry (task-artifacts.ts) + its production hooks: the
 * create-class pre-stat/record in runSandboxedPhase and the parent←child
 * propagation in pushCompletionToParent.
 *
 * Semantics under test: a SUCCESSFUL create-class tool call whose target did
 * NOT exist pre-execute enrolls the file as an artifact the agent itself
 * created. An overwrite of a pre-existing file never enrolls (the agent
 * edited the USER's file, it didn't create its own), a failed call never
 * enrolls even when it left bytes behind, membership is per-session, paths
 * are realpathDeep-canonical on BOTH the record and query sides (a symlinked
 * spelling can't split one inode into two identities), and artifacts
 * propagate parent←child like propagateTaint / propagateExternalIngestion.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
	recordTaskArtifact,
	isTaskArtifact,
	listTaskArtifacts,
	clearTaskArtifacts,
	propagateTaskArtifacts,
} from "./task-artifacts.js";
import { runSandboxedPhase } from "../tool-execution/run-sandboxed.js";
import type { ToolCallContext } from "../tool-execution/context.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { ok } from "../tools/result-helpers.js";
import { writeTool } from "../tools/read-write-tools.js";
import { setSessionWorkRoot, clearSessionWorkRoot, resolveAgentPath } from "../workspace/paths.js";
import { pushCompletionToParent } from "../agency/handler-completion.js";
import type { FieldAgent } from "../agency/handler-types.js";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let seq = 0;
function freshSession(): string { return `task-artifact-${seq++}`; }

const tmpRoots: string[] = [];
function tmpRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "task-artifacts-"));
	tmpRoots.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

// ── Registry semantics ───────────────────────────────────────────────────────

describe("task-artifact registry", () => {
	it("records, reports membership, and lists per session; other sessions stay clean", () => {
		const s = freshSession();
		const other = freshSession();
		const file = join(tmpRoot(), "report.md");
		expect(isTaskArtifact(s, file)).toBe(false);
		recordTaskArtifact(s, file);
		expect(isTaskArtifact(s, file)).toBe(true);
		expect(listTaskArtifacts(s)).toHaveLength(1);
		expect(isTaskArtifact(other, file)).toBe(false);
		expect(listTaskArtifacts(other)).toEqual([]);
		clearTaskArtifacts(s);
	});

	it("clearTaskArtifacts (test hook — no production caller) resets the session", () => {
		const s = freshSession();
		recordTaskArtifact(s, join(tmpRoot(), "a.txt"));
		clearTaskArtifacts(s);
		expect(listTaskArtifacts(s)).toEqual([]);
	});

	it("ignores an empty sessionId and an empty path", () => {
		recordTaskArtifact("", "/tmp/whatever.txt");
		expect(isTaskArtifact("", "/tmp/whatever.txt")).toBe(false);
		const s = freshSession();
		recordTaskArtifact(s, "");
		expect(listTaskArtifacts(s)).toEqual([]);
	});

	it("matches a symlinked spelling of a recorded path in BOTH directions (realpath-canonical membership)", () => {
		const s = freshSession();
		const root = tmpRoot();
		const realDir = join(root, "real");
		const linkDir = join(root, "link");
		mkdirSync(realDir);
		symlinkSync(realDir, linkDir);
		const realFile = join(realDir, "deck.pptx");
		writeFileSync(realFile, "pptx");

		// Recorded under the REAL spelling → queryable via the symlink.
		recordTaskArtifact(s, realFile);
		expect(isTaskArtifact(s, join(linkDir, "deck.pptx"))).toBe(true);
		clearTaskArtifacts(s);

		// Recorded under the SYMLINKED spelling → queryable via the realpath.
		recordTaskArtifact(s, join(linkDir, "deck.pptx"));
		expect(isTaskArtifact(s, realFile)).toBe(true);
		clearTaskArtifacts(s);
	});

	it("matches a differently-CASED spelling of a recorded artifact via inode identity; different files never match", () => {
		const s = freshSession();
		const root = tmpRoot();
		const target = join(root, "Case-Probe.md");
		writeFileSync(target, "cased");
		recordTaskArtifact(s, target);
		const lower = join(root, "case-probe.md");
		if (existsSync(lower)) {
			// Case-insensitive volume (macOS/Windows default): the other-cased
			// spelling is the SAME inode — the delete guard must see it.
			expect(isTaskArtifact(s, lower)).toBe(true);
		}
		// Zero false positives: an existing DIFFERENT file is a different inode.
		const other = join(root, "other.md");
		writeFileSync(other, "different file");
		expect(isTaskArtifact(s, other)).toBe(false);
		// And a non-existent query still misses cleanly.
		expect(isTaskArtifact(s, join(root, "never-created.md"))).toBe(false);
		clearTaskArtifacts(s);
	});

	it("propagates child → parent like propagateTaint; clean child is a no-op; re-propagation adds nothing", () => {
		const parent = freshSession();
		const child = freshSession();
		const file = join(tmpRoot(), "summary.xlsx");
		expect(propagateTaskArtifacts(child, parent)).toBe(0);
		recordTaskArtifact(child, file);
		expect(propagateTaskArtifacts(child, parent)).toBe(1);
		expect(isTaskArtifact(parent, file)).toBe(true);
		expect(propagateTaskArtifacts(child, parent)).toBe(0); // already present
		clearTaskArtifacts(parent);
		clearTaskArtifacts(child);
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

/** A create-class fake whose execute actually lands the file, like the real tools. */
function creatingTool(name: string, target: string, result?: () => ToolResult): ToolDefinition {
	return fakeTool(name, async () => {
		writeFileSync(target, "artifact bytes");
		return result ? result() : ok(`Created ${target}`);
	});
}

describe("runSandboxedPhase — task-artifact recording hook (create-class, did-not-exist-before)", () => {
	it("a successful write of a NEW file enrolls it (create-then-membership)", async () => {
		const s = freshSession();
		const target = join(tmpRoot(), "notes.md");
		await runSandboxedPhase(ctxFor(creatingTool("write", target), { path: target, content: "x" }, s));
		expect(isTaskArtifact(s, target)).toBe(true);
		expect(listTaskArtifacts(s)).toHaveLength(1);
		clearTaskArtifacts(s);
	});

	it("overwriting a PRE-EXISTING file does NOT enroll it — the agent edited a user file, it created nothing", async () => {
		const s = freshSession();
		const target = join(tmpRoot(), "existing.md");
		writeFileSync(target, "the user's own bytes");
		await runSandboxedPhase(ctxFor(creatingTool("write", target), { path: target, content: "x" }, s));
		expect(isTaskArtifact(s, target)).toBe(false);
		expect(listTaskArtifacts(s)).toEqual([]);
	});

	it("a FAILED create does not enroll — even when partial bytes landed on disk", async () => {
		const s = freshSession();
		const target = join(tmpRoot(), "half-written.pdf");
		const tool = creatingTool("write", target, () => ({ content: "disk full after partial write", isError: true }));
		await runSandboxedPhase(ctxFor(tool, { path: target, content: "x" }, s));
		expect(existsSync(target)).toBe(true); // bytes landed…
		expect(isTaskArtifact(s, target)).toBe(false); // …but SUCCESS-only enrolls
	});

	it("collapsed office families enroll only on their CREATE actions (spreadsheet write yes, read no)", async () => {
		const s = freshSession();
		const root = tmpRoot();
		const created = join(root, "sales.xlsx");
		await runSandboxedPhase(ctxFor(creatingTool("spreadsheet", created), { action: "write", file_path: created, data: "[]" }, s));
		expect(isTaskArtifact(s, created)).toBe(true);

		const preExisting = join(root, "user-data.xlsx");
		writeFileSync(preExisting, "user workbook");
		await runSandboxedPhase(ctxFor(fakeTool("spreadsheet", async () => ok("| a |")), { action: "read", file_path: preExisting }, s));
		expect(isTaskArtifact(s, preExisting)).toBe(false);
		clearTaskArtifacts(s);
	});

	it("create_chart enrolls the tool's OWN derived output path (absolute input, .png appended)", async () => {
		const s = freshSession();
		const requested = join(tmpRoot(), "revenue"); // no extension — chartOutPath appends .png
		const derived = `${requested}.png`;
		await runSandboxedPhase(ctxFor(creatingTool("create_chart", derived), { file_path: requested, type: "bar", series: "[]" }, s));
		expect(isTaskArtifact(s, derived)).toBe(true);
		expect(isTaskArtifact(s, requested)).toBe(false);
		clearTaskArtifacts(s);
	});

	it("MB-1/P2: a work-rooted session's RELATIVE write enrolls the ACTUAL written path, not the project-root spelling", async () => {
		// The registry's primary customers (delegated/auto-build workers) run
		// with a registered session work root: the REAL write tool resolves
		// relative paths against it via sessionIdOf(args) (_sessionId is
		// stamped by the resolve phase — mirrored here). A sessionless resolve
		// in the hook enrolled a never-created project-root path (future
		// false delete-block) and missed the real artifact (delete-guard hole).
		const s = freshSession();
		const workRoot = tmpRoot();
		setSessionWorkRoot(s, workRoot);
		try {
			const ctx = ctxFor(writeTool, { path: "chunk-artifact.md", content: "built by worker", _sessionId: s }, s);
			await runSandboxedPhase(ctx);
			expect(ctx.result!.isError).toBeFalsy();
			const actual = join(workRoot, "chunk-artifact.md");
			expect(existsSync(actual)).toBe(true);
			expect(isTaskArtifact(s, actual)).toBe(true);
			// The sessionless (project-root-anchored) spelling was never created
			// and must NOT be enrolled.
			const sessionless = resolveAgentPath("chunk-artifact.md");
			expect(sessionless).not.toBe(actual);
			expect(isTaskArtifact(s, sessionless)).toBe(false);
		} finally {
			clearSessionWorkRoot(s);
			clearTaskArtifacts(s);
		}
	});

	it("a 'running' (async-started) result does not enroll — SUCCESS means envelope status ok, not merely !isError", async () => {
		const s = freshSession();
		const target = join(tmpRoot(), "async-out.md");
		const tool = fakeTool("write", async () => {
			writeFileSync(target, "partial bytes");
			return { content: "started in background", status: "running" } as ToolResult;
		});
		await runSandboxedPhase(ctxFor(tool, { path: target, content: "x" }, s));
		expect(existsSync(target)).toBe(true); // bytes landed…
		expect(isTaskArtifact(s, target)).toBe(false); // …but no finished deliverable yet
	});

	it("document template enrolls the filled OUTPUT file, never the template it read", async () => {
		const s = freshSession();
		const root = tmpRoot();
		const template = join(root, "letter-template.docx");
		writeFileSync(template, "the user's template");
		const out = join(root, "letter-filled.docx");
		await runSandboxedPhase(ctxFor(creatingTool("document", out), { action: "template", template_path: template, output_path: out, variables: "{}" }, s));
		expect(isTaskArtifact(s, out)).toBe(true);
		expect(isTaskArtifact(s, template)).toBe(false);
		clearTaskArtifacts(s);
	});

	it("presentation add_slide enrolls the tool's DERIVED output file (addSlideOutPath parity)", async () => {
		const s = freshSession();
		const root = tmpRoot();
		const original = join(root, "deck.pptx");
		writeFileSync(original, "the existing deck");
		const derived = join(root, "deck_slide_3.pptx"); // addSlideOutPath(original, 3)
		await runSandboxedPhase(ctxFor(creatingTool("presentation", derived), { action: "add_slide", file_path: original, slide: "{}", position: 3 }, s));
		expect(isTaskArtifact(s, derived)).toBe(true);
		expect(isTaskArtifact(s, original)).toBe(false);
		clearTaskArtifacts(s);
	});

	it("a non-create tool that happens to take a path adds no membership (cheap-set gate)", async () => {
		const s = freshSession();
		const target = join(tmpRoot(), "seen.txt");
		writeFileSync(target, "existing");
		await runSandboxedPhase(ctxFor(fakeTool("read", async () => ok("existing")), { path: target }, s));
		expect(listTaskArtifacts(s)).toEqual([]);
	});

	it("per-session isolation: session A's created file is not session B's artifact", async () => {
		const a = freshSession();
		const b = freshSession();
		const target = join(tmpRoot(), "mine.docx");
		await runSandboxedPhase(ctxFor(creatingTool("document", target), { action: "create", file_path: target, content: "x" }, a));
		expect(isTaskArtifact(a, target)).toBe(true);
		expect(isTaskArtifact(b, target)).toBe(false);
		clearTaskArtifacts(a);
	});

	it("realpath vs symlinked QUERY spelling both match a file recorded via the hook", async () => {
		const s = freshSession();
		const root = tmpRoot();
		const realDir = join(root, "out");
		mkdirSync(realDir);
		symlinkSync(realDir, join(root, "out-link"));
		const target = join(realDir, "brief.pdf");
		await runSandboxedPhase(ctxFor(creatingTool("pdf", target), { action: "create", file_path: target, content: "x" }, s));
		expect(isTaskArtifact(s, target)).toBe(true);
		expect(isTaskArtifact(s, join(root, "out-link", "brief.pdf"))).toBe(true);
		clearTaskArtifacts(s);
	});
});

// ── parent←child propagation wiring (handler-completion.ts) ─────────────────

describe("pushCompletionToParent — task-artifact propagation wiring", () => {
	it("child created a deliverable → parent session holds it after completion", async () => {
		const parent = freshSession();
		const child = freshSession();
		const target = join(tmpRoot(), "research.docx");
		await runSandboxedPhase(ctxFor(creatingTool("document", target), { action: "create", file_path: target, content: "x" }, child));
		expect(isTaskArtifact(child, target)).toBe(true);
		expect(isTaskArtifact(parent, target)).toBe(false);

		const agent = {
			id: "agt-ta-1",
			name: "author",
			parentSessionId: parent,
			runSessionId: child,
			output: [],
			startedAt: Date.now(),
			tokensUsed: 0,
			messageQueue: [],
		} as unknown as FieldAgent;
		pushCompletionToParent(agent, "succeeded", "done");

		expect(isTaskArtifact(parent, target)).toBe(true);
		clearTaskArtifacts(parent);
		clearTaskArtifacts(child);
	});

	it("child that created nothing leaves the parent registry empty", () => {
		const parent = freshSession();
		const agent = {
			id: "agt-ta-2",
			name: "worker",
			parentSessionId: parent,
			runSessionId: freshSession(),
			output: [],
			startedAt: Date.now(),
			tokensUsed: 0,
			messageQueue: [],
		} as unknown as FieldAgent;
		pushCompletionToParent(agent, "succeeded", "done");
		expect(listTaskArtifacts(parent)).toEqual([]);
	});
});
