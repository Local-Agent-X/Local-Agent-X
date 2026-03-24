import { resolve } from "node:path";
import { ToolCallDeniedError } from "@arikernel/core";
import { type Firewall, createFirewall } from "@arikernel/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { upstreamAdapter } from "../src/upstream.js";

const POLICY_PATH = resolve(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"policies",
	"safe-defaults.yaml",
);

function makeFirewall(name: string): Firewall {
	return createFirewall({
		principal: {
			name,
			capabilities: [
				{ toolClass: "http", actions: ["get"], constraints: { allowedHosts: ["api.example.com"] } },
				{ toolClass: "file", actions: ["read"], constraints: { allowedPaths: ["./data/**"] } },
				{ toolClass: "database", actions: ["query"] },
			],
		},
		policies: POLICY_PATH,
		auditLog: ":memory:",
	});
}

describe("upstreamAdapter", () => {
	let fw: Firewall;
	afterEach(() => {
		fw?.close();
	});

	it("executes allowed skill through firewall", async () => {
		fw = makeFirewall("upstream-basic");
		const adapter = new upstreamAdapter(fw);
		adapter.registerSkill("web_search", "http", "get", (args) => `Results for ${args.query}`);

		const result = await adapter.executeSkill("web_search", {
			query: "hello",
			url: "https://api.example.com/search",
		});
		expect(result).toBe("Results for hello");
	});

	it("blocks skill that violates constraints", async () => {
		fw = makeFirewall("upstream-deny");
		const adapter = new upstreamAdapter(fw);
		adapter.registerSkill("read_file", "file", "read", (args) => `Contents of ${args.path}`);

		await expect(adapter.executeSkill("read_file", { path: "~/.ssh/id_rsa" })).rejects.toThrow(
			ToolCallDeniedError,
		);
	});

	it("throws on unknown skill name", async () => {
		fw = makeFirewall("upstream-unknown");
		const adapter = new upstreamAdapter(fw);

		await expect(adapter.executeSkill("nonexistent", {})).rejects.toThrow(/Unknown upstream skill/);
	});

	it("supports fluent registration and lists skills", async () => {
		fw = makeFirewall("upstream-fluent");
		const adapter = new upstreamAdapter(fw)
			.registerSkill("search", "http", "get", () => "a", { description: "Search the web" })
			.registerSkill("read", "file", "read", () => "b", { description: "Read a file" })
			.registerSkill("query", "database", "query", () => "c");

		expect(adapter.skillNames).toEqual(["search", "read", "query"]);

		const info = adapter.getSkillInfo();
		expect(info).toHaveLength(3);
		expect(info[0]).toEqual({
			name: "search",
			description: "Search the web",
			toolClass: "http",
			action: "get",
		});
		expect(info[2]).toEqual({
			name: "query",
			description: "",
			toolClass: "database",
			action: "query",
		});
	});

	it("triggers quarantine after repeated sensitive denials", async () => {
		fw = createFirewall({
			principal: {
				name: "upstream-quarantine",
				capabilities: [
					{ toolClass: "file", actions: ["read"], constraints: { allowedPaths: ["./data/**"] } },
				],
			},
			policies: POLICY_PATH,
			auditLog: ":memory:",
			runStatePolicy: { maxDeniedSensitiveActions: 2 },
		});

		const adapter = new upstreamAdapter(fw);
		adapter.registerSkill("read_file", "file", "read", (args) => `data: ${args.path}`);

		for (const path of ["~/.ssh/id_rsa", "~/.aws/credentials", "/etc/shadow"]) {
			try {
				await adapter.executeSkill("read_file", { path });
			} catch {}
		}

		expect(fw.isRestricted).toBe(true);
	});

	it("handler never executes when call is denied", async () => {
		fw = makeFirewall("upstream-no-exec");
		let handlerCalled = false;
		const adapter = new upstreamAdapter(fw);
		adapter.registerSkill("read_file", "file", "read", () => {
			handlerCalled = true;
		});

		try {
			await adapter.executeSkill("read_file", { path: "~/.ssh/id_rsa" });
		} catch {}

		expect(handlerCalled).toBe(false);
	});
});
