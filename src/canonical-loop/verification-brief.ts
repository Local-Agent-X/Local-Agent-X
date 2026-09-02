/**
 * Verification-op brief builder — the prompt handed to the background model
 * that audits a finished deliverable against its recorded inputs.
 *
 * Pure text assembly over the provenance sidecar (data-lineage/provenance.ts,
 * an outward import — legal under the interface seal, which constrains only
 * imports INTO canonical-loop). Deterministic aside from the sidecar reads:
 * no clocks, no randomness, no network. Never throws — readProvenance already
 * degrades to [] on any failure, and this module keeps the same posture
 * around its own input handling (a malformed deliverable list yields a brief,
 * not an exception, because the verification op must not be the thing that
 * crashes a task).
 *
 * The brief's contract (the trigger chunk and the verifier depend on it):
 *   - adversarial mandate: assume the deliverable is wrong; re-acquire 3-7
 *     load-bearing values from sources OTHER than the claimed ones;
 *   - per deliverable: path + claimed sources from provenance (deduped,
 *     newest first); a deliverable with no records gets an explicit
 *     "no sources declared is itself a finding" instruction;
 *   - the parent task's one-line description for context;
 *   - a verbatim first-line output contract (`VERDICT: ...`) plus per-value
 *     table shape;
 *   - bounded at MAX_BRIEF_CHARS: source lists shrink first (newest kept,
 *     truncation noted in the brief), then the deliverable list; the mandate
 *     and output contract are NEVER truncated.
 */
import { readProvenance, type ProvenanceSource } from "../data-lineage/provenance.js";

/** Hard cap on the assembled brief. Fixed sections (mandate, parent-task
 *  line, output contract) always survive intact; only the deliverable
 *  section shrinks to fit. */
export const MAX_BRIEF_CHARS = 8_000;

/** The parent-task context is a one-liner; clip so the never-truncated fixed
 *  sections stay bounded no matter what the caller passes. */
const MAX_PARENT_TASK_CHARS = 300;

const MANDATE = [
	"You are auditing another agent's deliverable. Assume it is wrong until confirmed.",
	"",
	"Mandate:",
	"1. Read each deliverable listed below with the matching read tool: spreadsheet_read for spreadsheets (.xlsx/.csv), document_read for documents (.docx), read otherwise.",
	"2. Pick 3-7 load-bearing values — the figures the deliverable's conclusions rest on (totals, prices, dates, shares, named quantities).",
	"3. For each value, acquire the figure from a source OTHER than the one the deliverable claims: web_search first, then web_fetch a DIFFERENT domain than the claimed source. If no second source exists, re-fetch the claimed source fresh with web_fetch and compare against what the deliverable recorded.",
	"4. Compare NFC-normalized text (Unicode NFC — normalize both sides before comparing) and numerically parsed values (strip currency symbols, thousands separators, and units before comparing numbers), reading the deliverable side with the spreadsheet/document read tools. Never compare raw bytes.",
	"5. A claimed source that no longer states the figure, or states a different one, is a discrepancy — report it even if an independent source agrees with the deliverable.",
].join("\n");

const OUTPUT_CONTRACT = [
	"Output contract:",
	"The FIRST line of your final answer MUST be `VERDICT: CONFIRMED | DISCREPANCIES | UNVERIFIABLE`",
	"After the verdict line, output a per-value table with columns: value, deliverable says, independent source says, match?",
	"Use CONFIRMED only when every checked value matches; DISCREPANCIES when any value conflicts; UNVERIFIABLE when independent figures could not be obtained for the load-bearing values.",
].join("\n");

const NO_SOURCES_INSTRUCTION =
	"No sources declared in provenance. Treat \"no sources declared\" as itself a finding to report: "
	+ "the deliverable's figures cannot be attributed, so verify its load-bearing values entirely from independent sources.";

interface DeliverableEntry {
	path: string;
	/** Deduped claimed sources, newest record first. */
	sources: ProvenanceSource[];
}

/** Claimed sources for one deliverable: flatten its provenance records
 *  newest-first and dedupe on the full (url, file, ref, note) tuple, so the
 *  survivor of a duplicate is its newest occurrence — the right end to keep
 *  when the size cap trims the tail. */
function collectSources(path: string): ProvenanceSource[] {
	let records;
	try {
		records = readProvenance(path);
	} catch {
		return []; // readProvenance never throws; belt-and-suspenders anyway.
	}
	const seen = new Set<string>();
	const out: ProvenanceSource[] = [];
	for (let i = records.length - 1; i >= 0; i--) {
		for (const source of records[i]?.sources ?? []) {
			const key = JSON.stringify([source.url ?? "", source.file ?? "", source.ref ?? "", source.note ?? ""]);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(source);
		}
	}
	return out;
}

function renderSource(source: ProvenanceSource): string {
	const parts: string[] = [];
	if (source.url) parts.push(`url: ${source.url}`);
	if (source.file) parts.push(`file: ${source.file}`);
	if (source.ref) parts.push(`ref: ${source.ref}`);
	if (source.note) parts.push(`note: ${source.note}`);
	return `   - ${parts.join(" — ")}`;
}

/** One deliverable's block, showing at most maxSources of its newest claimed
 *  sources. A truncated list says so IN the brief (the verifier must know the
 *  attribution is partial); a genuinely bare deliverable gets the
 *  no-sources-declared finding instruction instead — never the omission note. */
function renderDeliverable(entry: DeliverableEntry, index: number, maxSources: number): string {
	const lines = [`${index + 1}. ${entry.path}`];
	if (entry.sources.length === 0) {
		lines.push(`   ${NO_SOURCES_INSTRUCTION}`);
		return lines.join("\n");
	}
	const shown = entry.sources.slice(0, maxSources);
	if (shown.length > 0) {
		lines.push("   Claimed sources (newest first, deduped):");
		for (const source of shown) lines.push(renderSource(source));
	}
	const omitted = entry.sources.length - shown.length;
	if (omitted > 0) {
		lines.push(`   [${omitted} older source${omitted === 1 ? "" : "s"} omitted to fit the brief size cap — the newest ${shown.length} are shown]`);
	}
	return lines.join("\n");
}

function renderDeliverableSection(entries: DeliverableEntry[], maxSources: number, omittedDeliverables: number): string {
	const blocks = entries.length > 0
		? entries.map((entry, i) => renderDeliverable(entry, i, maxSources))
		: ["(no deliverables listed)"];
	if (omittedDeliverables > 0) {
		blocks.push(`[${omittedDeliverables} more deliverable${omittedDeliverables === 1 ? "" : "s"} omitted to fit the brief size cap]`);
	}
	return `Deliverables and their claimed sources:\n${blocks.join("\n")}`;
}

function assemble(parentTaskLine: string, deliverableSection: string): string {
	return [
		MANDATE,
		`Parent task: ${parentTaskLine}`,
		deliverableSection,
		OUTPUT_CONTRACT,
	].join("\n\n");
}

/**
 * Build the verification op's brief for a set of deliverable paths.
 * Deterministic aside from provenance sidecar reads; never throws; output is
 * at most MAX_BRIEF_CHARS unless the fixed sections alone exceed the cap
 * (they are constant-plus-300-chars and never truncated, by contract).
 */
export function buildVerificationBrief(input: { deliverables: string[]; parentTask: string }): string {
	const rawDeliverables = Array.isArray(input?.deliverables) ? input.deliverables : [];
	const paths = rawDeliverables.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
	const parentRaw = typeof input?.parentTask === "string" ? input.parentTask : "";
	const oneLine = parentRaw.replace(/\s+/g, " ").trim() || "(not provided)";
	const parentTaskLine = oneLine.length > MAX_PARENT_TASK_CHARS
		? `${oneLine.slice(0, MAX_PARENT_TASK_CHARS)}…`
		: oneLine;

	const entries: DeliverableEntry[] = paths.map((path) => ({ path, sources: collectSources(path) }));

	// Fit ladder, coarsest knob last: (1) shrink every source list in lockstep
	// down to zero, keeping the newest entries; (2) drop deliverables from the
	// end of the list; (3) hard-clip the deliverable section. The mandate and
	// output contract ride through every rung untouched.
	const maxObservedSources = entries.reduce((max, entry) => Math.max(max, entry.sources.length), 0);
	for (let k = maxObservedSources; k >= 0; k--) {
		const brief = assemble(parentTaskLine, renderDeliverableSection(entries, k, 0));
		if (brief.length <= MAX_BRIEF_CHARS) return brief;
	}
	for (let n = entries.length - 1; n >= 1; n--) {
		const brief = assemble(parentTaskLine, renderDeliverableSection(entries.slice(0, n), 0, entries.length - n));
		if (brief.length <= MAX_BRIEF_CHARS) return brief;
	}
	const skeleton = assemble(parentTaskLine, "");
	const budget = Math.max(0, MAX_BRIEF_CHARS - skeleton.length);
	const clipped = renderDeliverableSection(entries.slice(0, 1), 0, Math.max(0, entries.length - 1)).slice(0, budget);
	return assemble(parentTaskLine, clipped);
}
