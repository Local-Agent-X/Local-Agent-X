/**
 * The sensitive-path matcher judges a file by its SHAPE, never by a substring
 * of its name — replayed from the two quarantines of 2026-09-28 in the host's
 * real sessions, where `scripts/set-unsub-secret.mjs` (a script the agent had
 * written, named for what it does) counted as a credential file:
 *   02:51Z  file.write of it, then an http.post → rule 3 quarantined the run;
 *   03:24Z  file.read of it, then an http.get carrying an Authorization header
 *           → "custom headers after a sensitive read", quarantine, cascade.
 * Both sequences are pinned as allowed here; the same sequences on a genuine
 * credential file (.env) are pinned as still denied.
 */

import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { ToolCallDeniedError } from "@arikernel/core";
import { afterEach, describe, expect, it } from "vitest";
import { type Firewall, RunStateTracker, createFirewall } from "../src/index.js";
import { isSensitivePath } from "../src/run-state/sensitive-paths.js";

const POLICY_PATH = resolve(import.meta.dirname, "..", "..", "..", "policies", "safe-defaults.yaml");
const auditFiles: string[] = [];

afterEach(() => {
	for (const f of auditFiles) {
		try {
			unlinkSync(f);
		} catch {}
	}
	auditFiles.length = 0;
});

function makeFirewall(name: string, sensitivePath?: (p: string) => boolean): Firewall {
	const auditLog = resolve(import.meta.dirname, `test-path-shape-${name}-${Date.now()}.db`);
	auditFiles.push(auditLog);
	const fw = createFirewall({
		principal: {
			name: "test-agent",
			capabilities: [
				{ toolClass: "http", actions: ["get", "head", "post"], constraints: { allowedHosts: ["*"] } },
				{ toolClass: "file", actions: ["read", "write"], constraints: { allowedPaths: ["./**"] } },
			],
		},
		policies: POLICY_PATH,
		auditLog,
		hooks: { onApprovalRequired: async () => true },
		runStatePolicy: { maxDeniedSensitiveActions: 5, behavioralRules: true, sensitivePath },
	});
	fw.registerExecutor({
		toolClass: "http",
		async execute(toolCall) {
			return { callId: toolCall.id, success: true, data: { body: "ok" }, durationMs: 1, taintLabels: [] };
		},
	});
	fw.registerExecutor({
		toolClass: "file",
		async execute(toolCall) {
			return { callId: toolCall.id, success: true, data: { content: "export {};" }, durationMs: 1, taintLabels: [] };
		},
	});
	return fw;
}

const SCRIPT = "./workspace/scripts/set-unsub-secret.mjs";
const ENV = "./proj/.env";
const AUTH_GET = {
	url: "https://api.resend.com/domains",
	headers: { Authorization: "Bearer {{RESEND_API_KEY}}" },
};
const POST = { url: "https://api.supabase.com/v1/projects/p/database/query", body: "{}" };

async function file(fw: Firewall, action: "read" | "write", path: string) {
	const grant = fw.requestCapability(`file.${action}`);
	return fw.execute({ toolClass: "file", action, parameters: { path, content: "x" }, grantId: grant.grant?.id });
}
async function http(fw: Firewall, action: "get" | "post", parameters: Record<string, unknown>) {
	const grant = fw.requestCapability(action === "get" ? "http.read" : "http.write");
	return fw.execute({ toolClass: "http", action, parameters, grantId: grant.grant?.id });
}
async function denied(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(ToolCallDeniedError);
		return (e as ToolCallDeniedError).decision.reason;
	}
	return expect.unreachable("should have thrown");
}

describe("isSensitivePath: a name is not a credential file", () => {
	it("does not match files named for their subject", () => {
		for (const p of [
			"C:\\Users\\peter\\Documents\\Local Agent X\\workspace\\scripts\\set-unsub-secret.mjs",
			"/proj/src/tokenStore.ts",
			"/proj/src/passwordReset.ts",
			"/proj/src/credentials-form.tsx",
			"/proj/docs/secrets-rotation.md",
			"/proj/env.d.ts",
			"/proj/notes.key.md",
		]) {
			expect(isSensitivePath(p), p).toBe(false);
		}
	});

	it("matches credential files by basename, extension and credential directory", () => {
		for (const p of [
			"/proj/.env",
			"/proj/.env.local",
			"/home/u/.ssh/id_rsa",
			"/home/u/.ssh/config",
			"/home/u/.aws/credentials",
			"/home/u/.kube/config",
			"/home/u/.gnupg/secring.gpg",
			"/vault/server.pem",
			"/vault/secret.key",
			"C:\\Users\\u\\.git-credentials",
			"/etc/app/secrets.json",
		]) {
			expect(isSensitivePath(p), p).toBe(true);
		}
	});

	it("uses the host's classifier when the policy supplies one", () => {
		const host = new RunStateTracker({ sensitivePath: (p) => p.endsWith("/vault.bin") });
		expect(host.isSensitivePath("/data/vault.bin")).toBe(true);
		expect(host.isSensitivePath("/proj/.env")).toBe(false);
		// The kernel still normalizes homoglyphs before the host sees the path.
		expect(host.isSensitivePath("/data/\uFF56ault.bin")).toBe(true);
	});
});

describe("rule 3 and the post-read header check judge the path by shape", () => {
	it("02:51Z — a write of set-unsub-secret.mjs followed by a POST is allowed", async () => {
		const fw = makeFirewall("write-then-post");
		await file(fw, "write", SCRIPT);
		const r = await http(fw, "post", POST);
		expect(r.success).toBe(true);
		expect(fw.isRestricted).toBe(false);
		fw.close();
	});

	it("03:24Z — a read of set-unsub-secret.mjs followed by a GET with an Authorization header is allowed", async () => {
		const fw = makeFirewall("read-then-auth-get");
		await file(fw, "read", SCRIPT);
		expect(fw.sensitiveReadObserved).toBe(false);
		const r = await http(fw, "get", AUTH_GET);
		expect(r.success).toBe(true);
		expect(fw.isRestricted).toBe(false);
		fw.close();
	});

	it("a read of .env followed by a POST still quarantines the run", async () => {
		const fw = makeFirewall("env-then-post");
		await file(fw, "read", ENV);
		expect(fw.sensitiveReadObserved).toBe(true);
		expect(await denied(http(fw, "post", POST))).toMatch(/behavioral rule/);
		expect(fw.isRestricted).toBe(true);
		expect(fw.quarantineInfo?.ruleId).toBe("sensitive_read_then_egress");
		fw.close();
	});

	it("a read of .env followed by a GET with an Authorization header is still denied", async () => {
		const fw = makeFirewall("env-then-auth-get");
		await file(fw, "read", ENV);
		expect(await denied(http(fw, "get", AUTH_GET))).toMatch(/Custom headers/);
		fw.close();
	});

	it("the host's classifier decides for the run, not the built-in catalog", async () => {
		const fw = makeFirewall("host-classifier", (p) => p.endsWith("/vault.bin"));
		await file(fw, "read", ENV);
		expect(fw.sensitiveReadObserved).toBe(false);
		await file(fw, "read", "./data/vault.bin");
		expect(fw.sensitiveReadObserved).toBe(true);
		expect(await denied(http(fw, "post", POST))).toMatch(/behavioral rule/);
		fw.close();
	});
});
