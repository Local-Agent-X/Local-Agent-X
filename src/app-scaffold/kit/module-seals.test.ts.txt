/**
 * Module boundaries, two kinds:
 *
 * SEALS — code outside a sealed module may import it only through its public
 * entry points. An agent can then learn a module from its index file alone,
 * and a reach into internals fails here instead of silently coupling two
 * modules. Add a row when a module gains a few outside importers (the codebase
 * map shows importer counts). If a symbol is missing from a module's public
 * surface, export it from the entry point — don't loosen the seal.
 *
 * FORBIDDEN — a module that must never depend on another at all, by any path:
 * the UI never reaches the database, a tool never bypasses the execution
 * pipeline. The layering rules ARCHITECTURE.md states in prose become failing
 * tests. The map's "Module dependencies" table shows today's edges.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Directory containing this test = the source root. Adjust if the test lives elsewhere.
const SRC = fileURLToPath(new URL(".", import.meta.url));

interface Seal {
	/** Module directory, relative to SRC. */
	dir: string;
	/** Allowed paths inside the module, relative to it, without extension. "index" = the front door. */
	publicEntries: string[];
}

const SEALS: Seal[] = [
	// { dir: "billing", publicEntries: ["index"] },
];

interface Boundary {
	/** Module directory, relative to SRC, whose files may not import `to`. */
	from: string;
	to: string;
	/** The rule, in words — it is the failure message. */
	why: string;
}

const FORBIDDEN: Boundary[] = [
	// { from: "ui", to: "db", why: "the UI reads data through api/, never the database" },
];

const SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`]+)["'`]/g;

function* sourceFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* sourceFiles(full);
		else if (/\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield full;
	}
}

function violationsFor(seal: Seal): string[] {
	const moduleDir = resolve(SRC, seal.dir);
	const allowed = new Set(seal.publicEntries.map((e) => resolve(moduleDir, e)));
	const out: string[] = [];
	for (const file of sourceFiles(SRC)) {
		if (file.startsWith(moduleDir + sep)) continue;
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(SPECIFIER)) {
			const spec = m[1];
			if (!spec.startsWith(".")) continue;
			const target = resolve(file, "..", spec).replace(/\.(m|c)?[jt]sx?$/, "");
			const inside = target === moduleDir || target.startsWith(moduleDir + sep);
			if (!inside) continue;
			const entry = target === moduleDir ? resolve(moduleDir, "index") : target;
			if (allowed.has(entry)) continue;
			const line = text.slice(0, m.index).split("\n").length;
			out.push(`${relative(SRC, file).split(sep).join("/")}:${line} → "${spec}"`);
		}
	}
	return out;
}

function crossingsFor(rule: Boundary): string[] {
	const fromDir = resolve(SRC, rule.from);
	const toDir = resolve(SRC, rule.to);
	const out: string[] = [];
	for (const file of sourceFiles(fromDir)) {
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(SPECIFIER)) {
			if (!m[1].startsWith(".")) continue;
			const target = resolve(file, "..", m[1]);
			if (target !== toDir && !target.startsWith(toDir + sep)) continue;
			out.push(`${relative(SRC, file).split(sep).join("/")}:${text.slice(0, m.index).split("\n").length} → "${m[1]}"`);
		}
	}
	return out;
}

describe("module seals", () => {
	it.each(SEALS.length ? SEALS : [null])("%o is imported only through its public entries", (seal) => {
		if (!seal) return; // no seals yet
		const violations = violationsFor(seal);
		expect(
			violations,
			`Deep imports into ${seal.dir}/ — import from ${seal.publicEntries.map((e) => `${seal.dir}/${e}`).join(" or ")} ` +
				`(export the symbol there if it is missing):\n  ${violations.join("\n  ")}`,
		).toEqual([]);
	});
});

describe("forbidden dependencies", () => {
	it.each(FORBIDDEN.length ? FORBIDDEN : [null])("%o is never crossed", (rule) => {
		if (!rule) return; // no rules yet
		const crossings = crossingsFor(rule);
		expect(crossings, `${rule.from}/ must not import ${rule.to}/: ${rule.why}\n  ${crossings.join("\n  ")}`).toEqual([]);
	});
});
