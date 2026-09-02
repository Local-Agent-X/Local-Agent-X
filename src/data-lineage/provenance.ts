/**
 * Data Lineage — provenance sidecar store for deliverable source attribution.
 *
 * Third member of the lineage family: the taint registry (taint.ts) answers
 * "did this session touch OUR secrets?" and the ingestion registry
 * (external.ts) answers "did this session ingest UNTRUSTED off-box content?".
 * This store answers the forward question about OUTPUT: "where did the claims
 * in this deliverable FILE come from?" — a machine-readable record of the
 * sources (urls / files / refs / notes) attached to each annotated write, so
 * a verification op can check a deliverable against its actual inputs instead
 * of trusting the model's prose. Writers are the tool-execution audit phase
 * (records one entry per annotated deliverable write); readers are the
 * verification op's brief. This module is ONLY the store: durable append +
 * read keyed to the deliverable file, no recording hooks.
 *
 * Storage is a sidecar JSONL per deliverable at
 * ~/.lax/provenance/<sha1(realpath)>.jsonl — one file per deliverable keeps
 * reads cheap (no global scan) and lets a deliverable's history be dropped
 * wholesale, mirroring the action ledger's per-session layout
 * (ops/action-ledger.ts). Keying by realpathDeep (workspace/paths.ts), not
 * the raw spelling, because path IDENTITY must survive symlinked spellings —
 * on this box the workspace is a junction, so a raw-spelling key would split
 * one deliverable's history across two sidecars. The ~/.lax root comes from
 * the canonical resolver (lax-data-dir.ts), never a hardcoded home path.
 *
 * Persistence posture mirrors the action ledger exactly: durable-jsonl
 * (persistence/durable-jsonl.ts) for locked, fsynced appends with torn-tail
 * repair on read; appends are best-effort (log, never throw — a deliverable
 * write must not fail because its attribution sidecar is unwritable) and
 * reads degrade to [] on any failure. Input hygiene is the writer's problem
 * solved HERE: malformed source entries (non-object, all-empty) are dropped
 * silently, and per-record source count + string lengths are capped so a
 * runaway caller cannot bloat the sidecar.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";
import { realpathDeep } from "../workspace/paths.js";
import { readDurableJsonl, updateDurableJsonl } from "../persistence/durable-jsonl.js";

const logger = createLogger("data-lineage.provenance");

/** Max source entries stored per record — a runaway caller's excess is cut,
 *  oldest-first order preserved. */
export const MAX_SOURCES_PER_RECORD = 20;
/** Max chars stored per string field (record metadata and source fields
 *  alike; the canonical `file` key is exempt — clipping the key would corrupt
 *  identity, and OS path limits already bound it). */
export const MAX_FIELD_CHARS = 1_000;

/** One attributed input of a deliverable write. At least one field present. */
export interface ProvenanceSource {
	/** Off-box origin (web fetch / http / browser / search). */
	url?: string;
	/** On-box origin — a file whose content fed the write. */
	file?: string;
	/** Locator within the origin: anchor, page, line range, commit, … */
	ref?: string;
	/** Free-text qualifier ("headline figure", "verbatim quote", …). */
	note?: string;
}

/** One annotated deliverable write. */
export interface ProvenanceRecord {
	/** ISO timestamp of the write. */
	ts: string;
	sessionId: string;
	opId?: string;
	toolCallId: string;
	/** Tool that performed the write (write_file / edit / …). */
	tool: string;
	/** Tool sub-action, when the tool multiplexes (e.g. append vs overwrite). */
	action?: string;
	/** Deliverable path. Stored canonicalized (realpathDeep) — the same
	 *  identity the sidecar is keyed by. */
	file: string;
	sources: ProvenanceSource[];
}

function sidecarDir(): string {
	return join(getLaxDir(), "provenance");
}

function sidecarPath(canonicalFile: string): string {
	const digest = createHash("sha1").update(canonicalFile).digest("hex");
	return join(sidecarDir(), `${digest}.jsonl`);
}

/** realpathDeep over the resolved spelling — canonicalAllowForms' recipe.
 *  Tolerates a not-yet-existing deliverable (deepest existing ancestor is
 *  canonicalized); only ELOOP escapes, handled by each caller's posture. */
function canonicalFilePath(filePath: string): string {
	return realpathDeep(resolve(filePath));
}

const SOURCE_FIELDS = ["url", "file", "ref", "note"] as const;

/** Input hygiene: null for a malformed entry (non-object, or no non-empty
 *  string field) — the caller drops it silently; string fields clipped. */
function sanitizeSource(value: unknown): ProvenanceSource | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const out: ProvenanceSource = {};
	for (const key of SOURCE_FIELDS) {
		const field = raw[key];
		if (typeof field === "string" && field.trim()) out[key] = field.slice(0, MAX_FIELD_CHARS);
	}
	return Object.keys(out).length > 0 ? out : null;
}

function isStoredSource(value: unknown): value is ProvenanceSource {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const src = value as Record<string, unknown>;
	if (!SOURCE_FIELDS.every((key) => src[key] === undefined || typeof src[key] === "string")) return false;
	return SOURCE_FIELDS.some((key) => typeof src[key] === "string" && (src[key] as string).length > 0);
}

function isProvenanceRecord(value: unknown): value is ProvenanceRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Partial<ProvenanceRecord>;
	return typeof row.ts === "string" && typeof row.sessionId === "string"
		&& (row.opId === undefined || typeof row.opId === "string")
		&& typeof row.toolCallId === "string" && typeof row.tool === "string"
		&& (row.action === undefined || typeof row.action === "string")
		&& typeof row.file === "string" && row.file.length > 0
		&& Array.isArray(row.sources) && row.sources.every(isStoredSource);
}

function clip(text: string): string {
	return text.slice(0, MAX_FIELD_CHARS);
}

/**
 * Append one annotated write to the deliverable's sidecar. No-op when the
 * record lacks its identity fields or when NO source entry survives hygiene
 * (an unattributed record is noise here — the store exists to attribute).
 * Best-effort: a write failure is logged, never thrown.
 */
export function appendProvenance(record: ProvenanceRecord): void {
	if (!record.file || !record.sessionId || !record.toolCallId || !record.tool) return;
	try {
		const sources = record.sources
			.map(sanitizeSource)
			.filter((source): source is ProvenanceSource => source !== null)
			.slice(0, MAX_SOURCES_PER_RECORD);
		if (sources.length === 0) return;
		const canonical = canonicalFilePath(record.file);
		const stored: ProvenanceRecord = {
			ts: clip(record.ts),
			sessionId: clip(record.sessionId),
			...(record.opId !== undefined ? { opId: clip(record.opId) } : {}),
			toolCallId: clip(record.toolCallId),
			tool: clip(record.tool),
			...(record.action !== undefined ? { action: clip(record.action) } : {}),
			file: canonical,
			sources,
		};
		updateDurableJsonl(sidecarPath(canonical), isProvenanceRecord, () => stored);
	} catch (e) {
		logger.warn(`append failed file=${record.file}: ${(e as Error).message}`);
	}
}

/**
 * Read a deliverable's provenance records, oldest→newest. Any spelling of the
 * path (symlinked or canonical) reads the same sidecar. Empty array on a
 * missing sidecar or any failure — readers degrade, never throw.
 */
export function readProvenance(filePath: string): ProvenanceRecord[] {
	if (!filePath) return [];
	try {
		const path = sidecarPath(canonicalFilePath(filePath));
		if (!existsSync(path)) return [];
		return readDurableJsonl(path, isProvenanceRecord);
	} catch (e) {
		logger.warn(`read failed file=${filePath}: ${(e as Error).message}`);
		return [];
	}
}
