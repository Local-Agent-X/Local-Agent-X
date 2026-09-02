import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { evaluateShellCommandAndPaths } from "./shell-path-guard.js";
import { clearTaskArtifacts, recordTaskArtifact } from "../../data-lineage/task-artifacts.js";

// ── Task-artifact delete guard: shell rm/unlink/shred vs agent-created files ──
//
// A file the agent itself CREATED this task (data-lineage/task-artifacts.ts
// registry) must not be hard-deleted from the shell IN ANY MODE — delete_file
// routes it to the recoverable task trash. shell-policy's mode-aware rm rules
// left two holes for exactly these files: unrestricted mode allows flagged
// `rm -rf`, and bare `rm file` passes in EVERY mode. This suite pins both
// closed, and pins what the rule deliberately does NOT do: user files stay
// deletable (unrestricted means unrestricted for THEIR files), and glob/$VAR
// operands pass through — runtime-only shapes the guard's documented
// best-effort parsing cannot see; the verification pass is their backstop.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "lax-artifact-guard-")));
const WORKSPACE = join(ROOT, "workspace");
mkdirSync(WORKSPACE, { recursive: true });

const SESSION = "sess-artifact-delete-guard";
const REGISTERED = join(WORKSPACE, "report.md");
const REGISTERED_TXT = join(WORKSPACE, "summary.txt");
const USER_FILE = join(WORKSPACE, "user-notes.txt");
const LINK = join(ROOT, "link-to-report.md"); // symlinked spelling of REGISTERED
const OUT = join(WORKSPACE, "out"); // cd target holding a basename-colliding USER file
mkdirSync(OUT, { recursive: true });
writeFileSync(REGISTERED, "# agent deliverable\n", "utf-8");
writeFileSync(REGISTERED_TXT, "agent deliverable\n", "utf-8");
writeFileSync(USER_FILE, "the user's own file\n", "utf-8");
writeFileSync(join(OUT, "report.md"), "the user's own out/report.md\n", "utf-8");
symlinkSync(REGISTERED, LINK);
recordTaskArtifact(SESSION, REGISTERED);
recordTaskArtifact(SESSION, REGISTERED_TXT);

afterAll(() => {
	clearTaskArtifacts(SESSION);
	rmSync(ROOT, { recursive: true, force: true });
});

// Unrestricted mode is the sharp end: evaluateShellPaths is a no-op there and
// shell-policy's flagged-rm rule stands down, so ONLY the artifact rule can
// deny — every block below proves the rule is mode-independent.
const ctx = {
	workspace: WORKSPACE,
	fileAccessMode: "unrestricted" as const,
	inlineEvalPolicy: "allow" as const,
	allowedPathCheck: () => true,
	sessionId: SESSION,
};

const ARTIFACT_MESSAGE = "this file is a work product of the current task — use delete_file (recoverable) instead";

const expectArtifactBlock = (cmd: string) => {
	const d = evaluateShellCommandAndPaths(cmd, ctx);
	expect(d.allowed, `expected BLOCK for: ${cmd}`).toBe(false);
	expect(d.reason).toContain(ARTIFACT_MESSAGE);
};

describe("shell task-artifact delete guard — registered files are denied in unrestricted mode", () => {
	it("DENIES `rm -rf <registered>` (unrestricted mode's flagged-rm allowance does not cover artifacts)", () => {
		expectArtifactBlock(`rm -rf ${REGISTERED}`);
	});

	it("DENIES bare `rm <registered>` (the every-mode hole)", () => {
		expectArtifactBlock(`rm ${REGISTERED}`);
	});

	it("DENIES `unlink <registered>` and `shred -u <registered>`", () => {
		expectArtifactBlock(`unlink ${REGISTERED}`);
		expectArtifactBlock(`shred -u ${REGISTERED}`);
	});

	it("DENIES `rm -- <registered>` (operand after end-of-flags marker)", () => {
		expectArtifactBlock(`rm -- ${REGISTERED}`);
	});

	it("DENIES when ANY target is registered (`rm <user-file> <registered>`)", () => {
		expectArtifactBlock(`rm ${REGISTERED} ${USER_FILE}`);
		expectArtifactBlock(`rm ${USER_FILE} ${REGISTERED}`);
	});

	it("DENIES a registered target inside a re-parsed `bash -c` body", () => {
		expectArtifactBlock(`bash -c "rm ${REGISTERED}"`);
	});
});

describe("shell task-artifact delete guard — every spelling of a registered file resolves to it", () => {
	it("DENIES the workspace-RELATIVE spelling (`rm report.md` anchored at the workspace)", () => {
		expectArtifactBlock(`rm ${relative(WORKSPACE, REGISTERED)}`);
	});

	it("DENIES a `..`-detour absolute spelling (lexical resolve collapses it)", () => {
		expectArtifactBlock(`rm ${join(WORKSPACE, "..", "workspace", "report.md")}`);
	});

	it("DENIES a SYMLINKED spelling (registry realpath identity, not string match)", () => {
		expectArtifactBlock(`rm ${LINK}`);
	});
});

describe("shell task-artifact delete guard — what it deliberately does NOT block", () => {
	it("ALLOWS `rm <user-file>` in unrestricted mode (their files stay theirs to delete)", () => {
		const d = evaluateShellCommandAndPaths(`rm ${USER_FILE}`, ctx);
		expect(d.allowed, d.reason).toBe(true);
		expect(evaluateShellCommandAndPaths(`rm -f ${USER_FILE}`, ctx).allowed).toBe(true);
	});

	it("ALLOWS a glob operand even when it WOULD expand to a registered file (documented best-effort)", () => {
		// `${WORKSPACE}/*.txt` expands at runtime to summary.txt (registered) —
		// but the guard is a string parser by design (shell-path-guard.ts header):
		// it cannot expand globs, and must not pretend to. Backstop: verification.
		const d = evaluateShellCommandAndPaths(`rm ${join(WORKSPACE, "*.txt")}`, ctx);
		expect(d.allowed, d.reason).toBe(true);
	});

	it("ALLOWS a $VAR operand (runtime-only value the parser cannot see)", () => {
		const d = evaluateShellCommandAndPaths("rm $TARGET", ctx);
		expect(d.allowed, d.reason).toBe(true);
	});

	it("ALLOWS everything when NO sessionId is threaded (rule is inert, existing behavior)", () => {
		const { sessionId: _drop, ...anonymous } = ctx;
		const d = evaluateShellCommandAndPaths(`rm ${REGISTERED}`, anonymous);
		expect(d.allowed, d.reason).toBe(true);
	});

	it("ALLOWS the same paths for a DIFFERENT session (registry is per-session)", () => {
		const d = evaluateShellCommandAndPaths(`rm ${REGISTERED}`, { ...ctx, sessionId: "some-other-session" });
		expect(d.allowed, d.reason).toBe(true);
	});

	it("ALLOWS non-delete verbs touching a registered file (`cat`, `cp`)", () => {
		expect(evaluateShellCommandAndPaths(`cat ${REGISTERED}`, ctx).allowed).toBe(true);
		expect(evaluateShellCommandAndPaths(`cp ${REGISTERED} ${join(WORKSPACE, "copy.md")}`, ctx).allowed).toBe(true);
	});
});

describe("shell task-artifact delete guard — in-command cd makes relative operands ambiguous", () => {
	// After `cd out`, `rm report.md` names out/report.md (the USER's file), not
	// the registered workspace/report.md — anchoring it at the workspace would
	// false-deny. The rule skips relative operands once the cwd has shifted
	// (documented false-negative direction; the belt, not the primary).
	it("ALLOWS `cd out && rm report.md` — a basename-colliding USER file, not the artifact", () => {
		const d = evaluateShellCommandAndPaths("cd out && rm report.md", ctx);
		expect(d.allowed, d.reason).toBe(true);
		expect(evaluateShellCommandAndPaths("pushd out && rm report.md", ctx).allowed).toBe(true);
	});

	it("still DENIES an ABSOLUTE artifact spelling after a cd (only relative anchoring is ambiguous)", () => {
		expectArtifactBlock(`cd out && rm ${REGISTERED}`);
	});

	it("still DENIES plain `rm report.md` with NO cd (workspace anchoring holds)", () => {
		expectArtifactBlock("rm report.md");
	});
});

describe("shell task-artifact delete guard — single-level brace expansion (lexical)", () => {
	it("DENIES the empty-alternative form (`rm <registered>{,}`)", () => {
		expectArtifactBlock(`rm ${REGISTERED}{,}`);
	});

	it("DENIES the comma form naming a registered file (`rm {report,other}.md`)", () => {
		expectArtifactBlock("rm {report,other}.md");
	});

	it("ALLOWS a NESTED brace form (out of scope — the documented single-level bound)", () => {
		const d = evaluateShellCommandAndPaths("rm {report,{a,b}}.md", ctx);
		expect(d.allowed, d.reason).toBe(true);
	});
});

describe("shell task-artifact delete guard — re-parse depth bound (MAX_REPARSE_DEPTH)", () => {
	// Wrap `s` so shell-lex's tokenizeCommand hands it back as ONE token: quote
	// with `"`, splicing each internal `"` through an adjacent '"' span
	// (adjacent quoted spans concatenate — the same trick real shells use).
	const oneToken = (s: string) => `"${s.replaceAll('"', `"'"'"`)}"`;

	it("DENIES a DOUBLE-nested body (two re-lex levels are within the bound)", () => {
		expectArtifactBlock(`bash -c "bash -c 'rm ${REGISTERED}'"`);
	});

	it("ALLOWS a TRIPLE-nested body — pass-through at the documented two-level re-lex bound", () => {
		const levelA = `bash -c ${oneToken(`bash -c 'rm ${REGISTERED}'`)}`;
		const d = evaluateShellCommandAndPaths(`bash -c ${oneToken(levelA)}`, ctx);
		expect(d.allowed, d.reason).toBe(true);
	});
});
