/**
 * Verification brief builder (verification-brief.ts).
 *
 * Semantics under test: the brief is deterministic for fixed inputs (aside
 * from sidecar reads), always carries the adversarial mandate and the
 * verbatim VERDICT output contract, lists every deliverable with its deduped
 * claimed sources (newest first), gives the no-sources-declared finding
 * instruction ONLY to deliverables with no provenance, stays under
 * MAX_BRIEF_CHARS by trimming source lists first (newest kept, omission
 * noted in the brief) while the mandate + contract survive intact, and never
 * throws on unreadable or missing sidecars.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendProvenance, type ProvenanceRecord } from "../data-lineage/provenance.js";
import { buildVerificationBrief, MAX_BRIEF_CHARS } from "./verification-brief.js";

const MANDATE_LINE = "You are auditing another agent's deliverable. Assume it is wrong until confirmed.";
const VERDICT_LINE = "The FIRST line of your final answer MUST be `VERDICT: CONFIRMED | DISCREPANCIES | UNVERIFIABLE`";
const NO_SOURCES_MARKER = "No sources declared in provenance.";

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
	prevEnv = process.env.LAX_DATA_DIR;
	dir = mkdtempSync(join(tmpdir(), "lax-verification-brief-"));
	process.env.LAX_DATA_DIR = dir;
});

afterEach(() => {
	if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
	else process.env.LAX_DATA_DIR = prevEnv;
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function record(file: string, over: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
	return {
		ts: "2026-09-01T10:00:00.000Z",
		sessionId: "sess-1",
		toolCallId: "call_1",
		tool: "write_file",
		file,
		sources: [{ url: "https://example.com/report", note: "headline figure" }],
		...over,
	};
}

describe("buildVerificationBrief — structure", () => {
	it("carries mandate, verbatim verdict contract, parent task, NFC note, and every deliverable", () => {
		const sourced = join(dir, "report.md");
		appendProvenance(record(sourced, {
			sources: [
				{ url: "https://example.com/gan-market", ref: "table 3", note: "market share" },
				{ file: "/data/raw/vendors.csv", ref: "rows 2-14" },
			],
		}));
		const bare = join(dir, "summary.md");
		const brief = buildVerificationBrief({
			deliverables: [sourced, bare],
			parentTask: "Compile the 2026 GaN vendor market-share table",
		});

		expect(brief).toContain(MANDATE_LINE);
		expect(brief).toContain(VERDICT_LINE);
		expect(brief).toContain("value, deliverable says, independent source says, match?");
		expect(brief).toContain("Parent task: Compile the 2026 GaN vendor market-share table");
		// NFC comparison instruction is load-bearing for the verifier.
		expect(brief).toContain("NFC-normalized");
		// Both deliverables listed, sources rendered with their fields.
		expect(brief).toContain(`1. ${sourced}`);
		expect(brief).toContain(`2. ${bare}`);
		expect(brief).toContain("url: https://example.com/gan-market");
		expect(brief).toContain("ref: table 3");
		expect(brief).toContain("note: market share");
		expect(brief).toContain("file: /data/raw/vendors.csv");
		expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
	});

	it("is deterministic for fixed inputs", () => {
		const file = join(dir, "report.md");
		appendProvenance(record(file));
		const input = { deliverables: [file], parentTask: "Task X" };
		expect(buildVerificationBrief(input)).toBe(buildVerificationBrief(input));
	});

	it("gives the no-sources instruction ONLY to the bare deliverable", () => {
		const sourced = join(dir, "report.md");
		appendProvenance(record(sourced));
		const bare = join(dir, "summary.md");
		const brief = buildVerificationBrief({ deliverables: [sourced, bare], parentTask: "t" });

		expect(brief.split(NO_SOURCES_MARKER)).toHaveLength(2); // exactly one occurrence
		const bareBlock = brief.slice(brief.indexOf(`2. ${bare}`));
		expect(bareBlock).toContain(NO_SOURCES_MARKER);
		const sourcedBlock = brief.slice(brief.indexOf(`1. ${sourced}`), brief.indexOf(`2. ${bare}`));
		expect(sourcedBlock).not.toContain(NO_SOURCES_MARKER);
	});

	it("dedupes identical sources across records, keeping one rendering", () => {
		const file = join(dir, "report.md");
		const source = { url: "https://example.com/same", note: "dup" };
		appendProvenance(record(file, { toolCallId: "call_1", sources: [source] }));
		appendProvenance(record(file, { toolCallId: "call_2", sources: [source] }));
		const brief = buildVerificationBrief({ deliverables: [file], parentTask: "t" });
		expect(brief.split("url: https://example.com/same")).toHaveLength(2);
	});

	it("collapses a multi-line parent task to one line", () => {
		const brief = buildVerificationBrief({
			deliverables: [join(dir, "a.md")],
			parentTask: "line one\nline two\n\tline three",
		});
		expect(brief).toContain("Parent task: line one line two line three");
	});
});

describe("buildVerificationBrief — size cap", () => {
	it("trims source lists at the cap: newest kept, omission noted, mandate + contract intact", () => {
		const file = join(dir, "big-report.md");
		// 50 distinct sources via appendProvenance (one per record — the store
		// caps sources-per-record, not records). Long notes force overflow.
		for (let i = 0; i < 50; i++) {
			appendProvenance(record(file, {
				toolCallId: `call_${i}`,
				sources: [{ url: `https://example.com/source-${i}`, note: `figure ${i} ${"x".repeat(220)}` }],
			}));
		}
		const brief = buildVerificationBrief({ deliverables: [file], parentTask: "big task" });

		expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
		// Fixed sections survive truncation verbatim.
		expect(brief).toContain(MANDATE_LINE);
		expect(brief).toContain(VERDICT_LINE);
		expect(brief).toContain("value, deliverable says, independent source says, match?");
		// Truncation happened, is noted in the brief, and kept the newest end.
		expect(brief).toMatch(/older sources? omitted to fit the brief size cap/);
		expect(brief).toContain("url: https://example.com/source-49");
		expect(brief).not.toContain("https://example.com/source-0 "); // oldest dropped (trailing space avoids source-N prefix matches)
		// A truncated-but-sourced deliverable never gets the bare-deliverable line.
		expect(brief).not.toContain(NO_SOURCES_MARKER);
	});

	it("fits under the cap even with many deliverables and no sources at all", () => {
		const deliverables = Array.from({ length: 200 }, (_, i) => join(dir, `deliverable-${i}.md`));
		const brief = buildVerificationBrief({ deliverables, parentTask: "wide task" });
		expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
		expect(brief).toContain(MANDATE_LINE);
		expect(brief).toContain(VERDICT_LINE);
		expect(brief).toMatch(/more deliverables omitted to fit the brief size cap/);
	});
});

describe("buildVerificationBrief — defensive posture", () => {
	it("never throws on missing or unreadable sidecars", () => {
		const weird = [
			join(dir, "never-written.md"), // no sidecar at all
			"\u0000not-a-real-path", // canonicalization failure inside readProvenance
			"relative/spelling.md",
		];
		let brief = "";
		expect(() => { brief = buildVerificationBrief({ deliverables: weird, parentTask: "t" }); }).not.toThrow();
		expect(brief).toContain(MANDATE_LINE);
		expect(brief).toContain(VERDICT_LINE);
	});

	it("tolerates malformed input shapes", () => {
		expect(() => buildVerificationBrief({ deliverables: undefined as unknown as string[], parentTask: 7 as unknown as string })).not.toThrow();
		const brief = buildVerificationBrief({ deliverables: [], parentTask: "" });
		expect(brief).toContain("(no deliverables listed)");
		expect(brief).toContain("Parent task: (not provided)");
	});
});
