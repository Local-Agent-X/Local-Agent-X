/**
 * Firewall.judge returns a refusal as a value, so a host can tell a deny from
 * an engine fault without recognising the thrown error's class or name.
 */

import { describe, expect, it } from "vitest";
import { createFirewall } from "../src/index.js";

function firewall() {
	const fw = createFirewall({
		principal: {
			name: "test-agent",
			capabilities: [{ toolClass: "http", actions: ["get", "post"], constraints: { allowedHosts: ["*"] } }],
		},
		policies: [
			{
				id: "deny-post",
				name: "Deny post",
				priority: 1,
				match: { toolClass: "http", action: "post" },
				decision: "deny",
				reason: "no writes",
			},
			{
				id: "allow-get",
				name: "Allow get",
				priority: 2,
				match: { toolClass: "http", action: "get" },
				decision: "allow",
				reason: "reads are fine",
			},
		],
		auditLog: ":memory:",
	});
	fw.registerExecutor({
		toolClass: "http",
		async execute(toolCall) {
			return { callId: toolCall.id, success: true, data: "ok", durationMs: 1, taintLabels: [] };
		},
	});
	return fw;
}

describe("Firewall.judge", () => {
	it("an allowed call comes back with its result", async () => {
		const fw = firewall();
		const grant = fw.requestCapability("http.read");
		const j = await fw.judge({ toolClass: "http", action: "get", parameters: { url: "https://example.com" }, grantId: grant.grant?.id });
		expect(j).toMatchObject({ allowed: true, result: { success: true, data: "ok" } });
		fw.close();
	});

	it("a refused call is a verdict carrying the decision, not a throw", async () => {
		const fw = firewall();
		const j = await fw.judge({ toolClass: "http", action: "post", parameters: { url: "https://example.com" } });
		expect(j.allowed).toBe(false);
		if (j.allowed) throw new Error("unreachable");
		expect(j.decision.verdict).toBe("deny");
		expect(j.toolCall.action).toBe("post");
		fw.close();
	});

	it("an engine fault still throws", async () => {
		const fw = firewall();
		await expect(fw.judge({ toolClass: "bogus" as "http", action: "get", parameters: {} })).rejects.toThrow();
		fw.close();
	});
});
