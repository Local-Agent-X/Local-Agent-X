/**
 * Database tool calls emit metadata.table in their post-policy event. The rule
 * that once consumed it (Rule 6, secret_access_then_any_egress) quarantined the
 * run on the SEQUENCE "secrets-like table queried, then any HTTP POST" with no
 * evidence the POST carried a row — and is removed: the host judges data flow
 * (values masked at the source and registered, registered values refused at
 * every sink). These drive the real firewall to pin that the sequence is now
 * allowed end to end.
 */

import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Firewall, createFirewall } from "../src/index.js";

const auditFiles: string[] = [];

function auditPath(name: string): string {
	const path = resolve(import.meta.dirname, `test-secret-table-${name}-${Date.now()}.db`);
	auditFiles.push(path);
	return path;
}

afterEach(() => {
	for (const f of auditFiles) {
		try {
			unlinkSync(f);
		} catch {}
	}
	auditFiles.length = 0;
});

/** Permissive policy — lets behavioral rules be the enforcement layer. */
const ALLOW_ALL_RULES = [
	{
		id: "allow-all",
		name: "Allow everything",
		priority: 500,
		match: {},
		decision: "allow" as const,
		reason: "Test: allow all",
	},
];

function makeFirewall(name: string): Firewall {
	const fw = createFirewall({
		principal: {
			name: "test-agent",
			capabilities: [
				{ toolClass: "database", actions: ["query"] },
				{ toolClass: "http", actions: ["get", "post"], constraints: { allowedHosts: ["*"] } },
			],
		},
		policies: ALLOW_ALL_RULES,
		auditLog: auditPath(name),
		runStatePolicy: { maxDeniedSensitiveActions: 5, behavioralRules: true },
	});

	fw.registerExecutor({
		toolClass: "database",
		async execute(toolCall) {
			return {
				callId: toolCall.id,
				success: true,
				data: { rows: [{ key: "sk-abc123" }], rowCount: 1 },
				durationMs: 5,
				taintLabels: [],
			};
		},
	});
	fw.registerExecutor({
		toolClass: "http",
		async execute(toolCall) {
			return {
				callId: toolCall.id,
				success: true,
				data: { body: "ok" },
				durationMs: 10,
				taintLabels: [],
			};
		},
	});

	return fw;
}

describe("secrets-like table query then HTTP POST — table metadata, no sequence-only quarantine", () => {
	it("a query to a credentials table followed by an HTTP POST is allowed and leaves the run unrestricted", async () => {
		const fw = makeFirewall("credentials-egress");

		const dbGrant = fw.requestCapability("database.read");
		const httpGrant = fw.requestCapability("http.write");

		await fw.execute({
			toolClass: "database",
			action: "query",
			parameters: { table: "user_credentials" },
			grantId: dbGrant.grant?.id,
		});

		// The former rule 6 denied this on sequence alone. The POST body carries
		// nothing from the query; nothing in the kernel may infer otherwise.
		const result = await fw.execute({
			toolClass: "http",
			action: "post",
			parameters: { url: "https://api.example.com/report", body: "{}" },
			grantId: httpGrant.grant?.id,
		});
		expect(result.success).toBe(true);
		expect(fw.isRestricted).toBe(false);
	});

	it("a vault table name is no different — the POST after it is allowed", async () => {
		const fw = makeFirewall("vault-egress");

		const dbGrant = fw.requestCapability("database.read");
		const httpGrant = fw.requestCapability("http.write");

		await fw.execute({
			toolClass: "database",
			action: "query",
			parameters: { table: "vault_secrets" },
			grantId: dbGrant.grant?.id,
		});

		const result = await fw.execute({
			toolClass: "http",
			action: "post",
			parameters: { url: "https://api.example.com/report", body: "{}" },
			grantId: httpGrant.grant?.id,
		});
		expect(result.success).toBe(true);
		expect(fw.quarantineInfo).toBeNull();
	});

	it("allows egress after query to non-secrets table", async () => {
		const fw = makeFirewall("normal-table-egress");

		const dbGrant = fw.requestCapability("database.read");
		const httpGrant = fw.requestCapability("http.write");

		await fw.execute({
			toolClass: "database",
			action: "query",
			parameters: { table: "products" },
			grantId: dbGrant.grant?.id,
		});

		const result = await fw.execute({
			toolClass: "http",
			action: "post",
			parameters: { url: "https://api.example.com/report", body: "{}" },
			grantId: httpGrant.grant?.id,
		});
		expect(result.success).toBe(true);
	});
});
