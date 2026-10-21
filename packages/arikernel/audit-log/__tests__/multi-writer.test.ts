// The server and every execution worker it starts open the same audit file.
// A chain tip cached per AuditStore instance forked the chain at the first
// worker-backed op — each process chained onto the tip it last saw — so the
// whole database failed verification and real tampering was indistinguishable
// from that noise (red team 2026-10-13, A7). The tip is now read under the
// write lock at every append.
import type { Decision, ToolCall } from "@arikernel/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditStore, verifyDatabaseChain } from "../src/index.js";

const call = (runId: string, n: number): ToolCall => ({
	id: `tc-${runId}-${n}`,
	runId,
	sequence: 0,
	timestamp: new Date().toISOString(),
	principalId: "agent",
	toolClass: "http",
	action: "get",
	parameters: { url: `https://example.com/${n}` },
	taintLabels: [],
});
const allow: Decision = { verdict: "allow", matchedRule: null, reason: "test", taintLabels: [], timestamp: new Date().toISOString() };

describe("two stores on one file", () => {
	let dir = "";
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("interleave their appends into one valid chain", () => {
		dir = mkdtempSync(join(tmpdir(), "ari-audit-writers-"));
		const path = join(dir, "audit.db");
		const key = Buffer.from("shared-hmac-key-0123456789abcdef");
		const server = new AuditStore(path, key);
		const worker = new AuditStore(path, key);
		server.startRun("run-server", "agent", {});
		worker.startRun("run-worker", "agent", {});
		for (let i = 0; i < 5; i++) {
			server.append(call("run-server", i), allow);
			worker.append(call("run-worker", i), allow);
		}
		server.appendSystemEvent("run-server", "agent", "quarantine", "test", {});
		worker.append(call("run-worker", 5), allow);

		expect(verifyDatabaseChain(server).valid).toBe(true);
		expect(verifyDatabaseChain(worker).valid).toBe(true);
		server.close();
		worker.close();
	});
});
