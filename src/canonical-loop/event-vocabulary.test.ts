/**
 * Drift guard for the canonical event vocabulary.
 *
 * `CanonicalEventType` is DECLARED in one place and ENFORCED in three:
 *   1. types.ts                  — the union itself.
 *   2. store.ts                  — `EVENT_TYPES`, feeding `isCanonicalEvent`
 *      → `eventValidator`, used by BOTH the durable reader and writer.
 *   3. process-relay-contract.ts — `CANONICAL_EVENT_TYPES`, checked by
 *      `validateRelayPayload` on the out-of-process worker path.
 *
 * Nothing tied the three together, and the two Sets fail in OPPOSITE ways:
 *
 *  - store.ts is a `Set<CanonicalEventType>`, and a Set holding a SUBSET of
 *    the union is legal TypeScript — so omitting a name there COMPILES
 *    CLEAN. At runtime `isCanonicalEvent` then rejects the frame, and
 *    durable-jsonl's reader stops at the first invalid frame AND TRUNCATES
 *    the log to that offset: the event and every event after it are gone
 *    from disk. `assertEventSequence` derives the next seq from the
 *    surviving row count, so the damage is a seq gap/collision, not one
 *    missing row.
 *  - process-relay-contract.ts throws "invalid canonical relay payload" —
 *    loud, but only for ops running out of process.
 *
 * Hence both halves below: a COMPILE-TIME census of the union (adding a
 * member without listing it here fails `npm run build`), then a RUNTIME
 * proof that each validator actually accepts every member — plus negative
 * controls so neither proof can pass vacuously.
 */
import { describe, it, expect, afterAll } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent, CanonicalEventType } from "./types.js";

// The key type is `CanonicalEventType`, so this object is exhaustive by
// construction: a member added to the union and not listed here is a tsc
// error, and a name listed here that the union dropped is also a tsc error.
// This is the ONLY place the union's members are enumerated in tests.
const ALL_CANONICAL_EVENT_TYPES: Record<CanonicalEventType, true> = {
	state_changed: true,
	turn_started: true,
	turn_committed: true,
	iteration_checkpoint: true,
	tool_started: true,
	tool_finished: true,
	message_appended: true,
	redirect_received: true,
	redirect_applied: true,
	pause_requested: true,
	resume_requested: true,
	approval_requested: true,
	approval_resolved: true,
	cancel_requested: true,
	lease_acquired: true,
	lease_lost: true,
	error: true,
	middleware_fired: true,
};

const EVERY_TYPE = Object.keys(ALL_CANONICAL_EVENT_TYPES) as CanonicalEventType[];

// store.ts/schema.ts capture the ops base at module load, so the data-dir
// override must be in place before the dynamic imports below (same reason
// store-seq.test.ts imports that way).
const dataDir = mkdtempSync(join(tmpdir(), "lax-event-vocab-"));
process.env.LAX_DATA_DIR = dataDir;
const store = await import("./store.js");
const schema = await import("./schema.js");
const relay = await import("./process-relay-contract.js");

afterAll(() => {
	delete process.env.LAX_DATA_DIR;
	try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function isoNow(): string { return new Date().toISOString(); }

describe("canonical event vocabulary — store.ts EVENT_TYPES", () => {
	it.each(EVERY_TYPE)("round-trips a %s row through the durable log", (type) => {
		const opId = `op_vocab_${type}`;
		store.appendCanonicalEvent(opId, type, { probe: true });
		const rows = store.readCanonicalEvents(opId);
		expect(rows.map((e: CanonicalEvent) => e.type)).toEqual([type]);
	});

	it("keeps seq contiguous with one event of every type in one log", () => {
		// The blast radius, not just the missing row: an omitted name silently
		// shortens this log, and the next emit re-uses a seq that is already
		// on disk.
		const opId = "op_vocab_full_sequence";
		for (const type of EVERY_TYPE) store.appendCanonicalEvent(opId, type);
		const rows = store.readCanonicalEvents(opId);
		expect(rows.map((e: CanonicalEvent) => e.type)).toEqual(EVERY_TYPE);
		expect(rows.map((e: CanonicalEvent) => e.seq)).toEqual(EVERY_TYPE.map((_, i) => i));
	});

	it("drops the unknown row AND everything after it (the failure being guarded)", () => {
		// Written the way drift actually lands: a peer that knows a name this
		// build's EVENT_TYPES does not appends a well-formed frame. Proves the
		// tests above are not vacuous — the reader really does filter on type.
		const opId = "op_vocab_unknown_type";
		store.appendCanonicalEvent(opId, "turn_started");
		appendFileSync(schema.canonicalEventsPath(opId), `${JSON.stringify({
			opId, seq: 1, type: "middleware_misfired", ts: isoNow(), body: null,
		})}\n`);
		appendFileSync(schema.canonicalEventsPath(opId), `${JSON.stringify({
			opId, seq: 2, type: "turn_committed", ts: isoNow(), body: null,
		})}\n`);
		expect(store.readCanonicalEvents(opId).map((e: CanonicalEvent) => e.type))
			.toEqual(["turn_started"]);
	});
});

describe("canonical event vocabulary — process-relay CANONICAL_EVENT_TYPES", () => {
	const opId = "op_vocab_relay";

	it.each(EVERY_TYPE)("carries a %s event over the process relay", (type) => {
		expect(() => relay.validateRelayPayload(
			"canonical-event",
			{ opId, seq: 0, type, ts: isoNow(), body: null },
			opId,
		)).not.toThrow();
	});

	it("still rejects a type the union does not define", () => {
		expect(() => relay.validateRelayPayload(
			"canonical-event",
			{ opId, seq: 0, type: "middleware_misfired", ts: isoNow(), body: null },
			opId,
		)).toThrow("invalid canonical relay payload");
	});
});
