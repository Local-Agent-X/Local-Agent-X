/**
 * Read-side queries over the Facts DB — split from index-facts.ts (which keeps
 * the write side: retain / retainSmart / validity / purge) to stay under the
 * file-size cap. Re-exported from index-facts.ts so importers are unchanged.
 */
import type Database from "better-sqlite3";
import type { FactKind, RetainedFact } from "./types.js";
import { rowToFact, slugify } from "./utils.js";

export function recallByEntity(
	db: InstanceType<typeof Database>,
	entitySlug: string,
	limit = 20,
	opts?: { includeInvalidated?: boolean }
): RetainedFact[] {
	const slug = slugify(entitySlug);
	const validFilter = opts?.includeInvalidated ? "" : "AND f.valid_to IS NULL";
	const rows = db
		.prepare(
			`SELECT f.* FROM facts f
			 JOIN entity_mentions em ON em.fact_id = f.id
			 WHERE em.entity_slug = ? ${validFilter}
			 ORDER BY f.timestamp DESC
			 LIMIT ?`
		)
		.all(slug, limit) as Array<Record<string, unknown>>;

	return rows.map(rowToFact);
}

export function recallByKind(
	db: InstanceType<typeof Database>,
	kind: FactKind,
	limit = 20,
	opts?: { includeInvalidated?: boolean }
): RetainedFact[] {
	const validFilter = opts?.includeInvalidated ? "" : "AND valid_to IS NULL";
	const rows = db
		.prepare(`SELECT * FROM facts WHERE kind = ? ${validFilter} ORDER BY timestamp DESC LIMIT ?`)
		.all(kind, limit) as Array<Record<string, unknown>>;
	return rows.map(rowToFact);
}

// Every currently-valid fact across all kinds, newest first. Unlike
// recallRecentFacts (kind-filtered, confidence-gated, entity-deduped for prompt
// injection), this is the unfiltered candidate pool for importance ranking —
// stable high-confidence facts must not be excluded before they can be scored.
export function allValidFacts(
	db: InstanceType<typeof Database>,
	limit = 1000,
): RetainedFact[] {
	const rows = db
		.prepare(`SELECT * FROM facts WHERE valid_to IS NULL ORDER BY timestamp DESC LIMIT ?`)
		.all(limit) as Array<Record<string, unknown>>;
	return rows.map(rowToFact);
}

export function recallByTime(
	db: InstanceType<typeof Database>,
	since: Date,
	until?: Date,
	limit = 50,
	opts?: { includeInvalidated?: boolean }
): RetainedFact[] {
	const sinceMs = since.getTime();
	const untilMs = until ? until.getTime() : Date.now();
	const validFilter = opts?.includeInvalidated ? "" : "AND valid_to IS NULL";
	const rows = db
		.prepare(
			`SELECT * FROM facts WHERE timestamp >= ? AND timestamp <= ? ${validFilter}
			 ORDER BY timestamp DESC LIMIT ?`
		)
		.all(sinceMs, untilMs, limit) as Array<Record<string, unknown>>;
	return rows.map(rowToFact);
}

export function recallOpinions(
	db: InstanceType<typeof Database>,
	entitySlug?: string,
	opts?: { includeInvalidated?: boolean }
): RetainedFact[] {
	const validFilter = opts?.includeInvalidated ? "" : "AND f.valid_to IS NULL";
	if (entitySlug) {
		const slug = slugify(entitySlug);
		const rows = db
			.prepare(
				`SELECT f.* FROM facts f
				 JOIN entity_mentions em ON em.fact_id = f.id
				 WHERE f.kind = 'opinion' AND em.entity_slug = ? ${validFilter}
				 ORDER BY f.confidence DESC, f.last_updated DESC`
			)
			.all(slug) as Array<Record<string, unknown>>;
		return rows.map(rowToFact);
	}

	const bareValidFilter = opts?.includeInvalidated ? "" : "AND valid_to IS NULL";
	const rows = db
		.prepare(
			`SELECT * FROM facts WHERE kind = 'opinion' ${bareValidFilter} ORDER BY confidence DESC, last_updated DESC`
		)
		.all() as Array<Record<string, unknown>>;
	return rows.map(rowToFact);
}

export function recallAsOf(
	db: InstanceType<typeof Database>,
	asOf: Date,
	opts?: { kind?: FactKind; entitySlug?: string; limit?: number }
): RetainedFact[] {
	const t = asOf.getTime();
	const limit = opts?.limit ?? 50;
	const conditions: string[] = [
		"(f.valid_from IS NULL OR f.valid_from <= ?)",
		"(f.valid_to IS NULL OR f.valid_to > ?)",
	];
	const params: unknown[] = [t, t];
	let join = "";
	if (opts?.kind) { conditions.push("f.kind = ?"); params.push(opts.kind); }
	if (opts?.entitySlug) {
		join = "JOIN entity_mentions em ON em.fact_id = f.id";
		conditions.push("em.entity_slug = ?");
		params.push(slugify(opts.entitySlug));
	}
	params.push(limit);

	const rows = db
		.prepare(
			`SELECT f.* FROM facts f ${join}
			 WHERE ${conditions.join(" AND ")}
			 ORDER BY f.timestamp DESC LIMIT ?`
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(rowToFact);
}
