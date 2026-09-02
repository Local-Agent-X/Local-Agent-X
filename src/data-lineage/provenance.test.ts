/**
 * Provenance sidecar store (provenance.ts).
 *
 * Semantics under test: one durable JSONL sidecar per deliverable, keyed by
 * sha1(realpathDeep) under <lax-dir>/provenance — so distinct files never
 * collide and a symlinked spelling reads the same history; malformed sidecar
 * lines are repaired-past, not thrown (durable-jsonl posture, same as the
 * action ledger); malformed source entries are dropped silently at append;
 * source count and string lengths are capped; a missing sidecar reads as [].
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendProvenance,
	readProvenance,
	MAX_SOURCES_PER_RECORD,
	MAX_FIELD_CHARS,
	type ProvenanceRecord,
	type ProvenanceSource,
} from "./provenance.js";

let dir: string;
let prevEnv: string | undefined;

function record(over: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
	return {
		ts: "2026-09-01T10:00:00.000Z",
		sessionId: "sess-1",
		opId: "op_chat_turn_1",
		toolCallId: "call_1",
		tool: "write_file",
		action: "overwrite",
		file: join(dir, "deliverable.md"),
		sources: [{ url: "https://example.com/report", note: "headline figure" }],
		...over,
	};
}

function sidecarFiles(): string[] {
	try {
		return readdirSync(join(dir, "provenance")).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
}

beforeEach(() => {
	prevEnv = process.env.LAX_DATA_DIR;
	dir = mkdtempSync(join(tmpdir(), "lax-provenance-"));
	process.env.LAX_DATA_DIR = dir;
});

afterEach(() => {
	if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
	else process.env.LAX_DATA_DIR = prevEnv;
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("provenance sidecar IO", () => {
	it("round-trips a record through append → read", () => {
		appendProvenance(record());
		const rows = readProvenance(join(dir, "deliverable.md"));
		expect(rows).toHaveLength(1);
		expect(rows[0].sessionId).toBe("sess-1");
		expect(rows[0].tool).toBe("write_file");
		expect(rows[0].action).toBe("overwrite");
		expect(rows[0].sources).toEqual([{ url: "https://example.com/report", note: "headline figure" }]);
		expect(rows[0].file.endsWith("deliverable.md")).toBe(true);
	});

	it("keeps distinct deliverables in distinct sidecars (no collision)", () => {
		appendProvenance(record({ file: join(dir, "a.md") }));
		appendProvenance(record({ file: join(dir, "b.md"), sources: [{ file: "/etc/hosts" }] }));
		expect(sidecarFiles()).toHaveLength(2);
		const a = readProvenance(join(dir, "a.md"));
		const b = readProvenance(join(dir, "b.md"));
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
		expect(a[0].sources[0].url).toBe("https://example.com/report");
		expect(b[0].sources[0].file).toBe("/etc/hosts");
	});

	it("reads the same records through a symlinked spelling (realpath keying)", () => {
		const real = join(dir, "real.md");
		const link = join(dir, "link.md");
		writeFileSync(real, "content");
		symlinkSync(real, link);
		appendProvenance(record({ file: real }));
		appendProvenance(record({ file: link, sources: [{ ref: "L10-L20", note: "via link" }] }));
		expect(sidecarFiles()).toHaveLength(1);
		const viaReal = readProvenance(real);
		const viaLink = readProvenance(link);
		expect(viaReal).toHaveLength(2);
		expect(viaLink).toEqual(viaReal);
		expect(viaReal[0].file).toBe(viaReal[1].file);
	});

	it("returns [] for a deliverable with no sidecar", () => {
		expect(readProvenance(join(dir, "never-written.md"))).toEqual([]);
		expect(readProvenance(join(dir, "no", "such", "dir", "x.md"))).toEqual([]);
	});

	it("skips a malformed JSON line instead of throwing", () => {
		appendProvenance(record());
		const files = sidecarFiles();
		expect(files).toHaveLength(1);
		appendFileSync(join(dir, "provenance", files[0]), "{not json\n");
		const rows = readProvenance(join(dir, "deliverable.md"));
		expect(rows).toHaveLength(1);
		expect(rows[0].sources[0].url).toBe("https://example.com/report");
	});
});

describe("provenance input hygiene", () => {
	it("drops malformed source entries (non-object, all-empty) silently", () => {
		appendProvenance(record({
			sources: [
				null, 42, "https://bare-string", [],
				{}, { url: "" }, { note: "   " }, { bogus: "x" },
				{ url: "https://kept.example" },
			] as unknown as ProvenanceSource[],
		}));
		const rows = readProvenance(join(dir, "deliverable.md"));
		expect(rows).toHaveLength(1);
		expect(rows[0].sources).toEqual([{ url: "https://kept.example" }]);
	});

	it("drops the whole record when no source survives hygiene", () => {
		appendProvenance(record({ sources: [] }));
		appendProvenance(record({ sources: [{}, { url: "" }] as ProvenanceSource[] }));
		expect(readProvenance(join(dir, "deliverable.md"))).toEqual([]);
		expect(sidecarFiles()).toHaveLength(0);
	});

	it("no-ops on missing identity fields instead of throwing", () => {
		appendProvenance(record({ file: "" }));
		appendProvenance(record({ sessionId: "" }));
		appendProvenance(record({ toolCallId: "" }));
		appendProvenance(record({ tool: "" }));
		expect(sidecarFiles()).toHaveLength(0);
	});

	it("caps stored sources per record at MAX_SOURCES_PER_RECORD", () => {
		const many = Array.from({ length: MAX_SOURCES_PER_RECORD + 5 }, (_, i) => ({ ref: `src-${i}` }));
		appendProvenance(record({ sources: many }));
		const rows = readProvenance(join(dir, "deliverable.md"));
		expect(rows[0].sources).toHaveLength(MAX_SOURCES_PER_RECORD);
		expect(rows[0].sources[0].ref).toBe("src-0");
		expect(rows[0].sources[MAX_SOURCES_PER_RECORD - 1].ref).toBe(`src-${MAX_SOURCES_PER_RECORD - 1}`);
	});

	it("clips string fields to MAX_FIELD_CHARS", () => {
		const long = "x".repeat(MAX_FIELD_CHARS + 500);
		appendProvenance(record({ tool: long, sources: [{ note: long, url: "https://ok.example" }] }));
		const rows = readProvenance(join(dir, "deliverable.md"));
		expect(rows).toHaveLength(1);
		expect(rows[0].tool).toHaveLength(MAX_FIELD_CHARS);
		expect(rows[0].sources[0].note).toHaveLength(MAX_FIELD_CHARS);
		expect(rows[0].sources[0].url).toBe("https://ok.example");
	});
});
