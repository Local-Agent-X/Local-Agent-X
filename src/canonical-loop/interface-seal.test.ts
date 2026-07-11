/**
 * Interface seal for src/canonical-loop/.
 *
 * External code (anything under src/ outside this directory) must import
 * canonical-loop ONLY through its public interface:
 *
 *   - the front-door barrel:  .../canonical-loop/index.js  (or bare ".../canonical-loop")
 *   - a public sub-barrel:    .../canonical-loop/public/<name>.js
 *
 * Deep paths into internals (types.js, agent-runner.js, store.js,
 * instruction-ledger/*, turn-loop/*, adapters/*, ...) are banned — that is
 * how the module's boundary eroded to ~47 bypassing imports before the seal.
 * The public/ sub-barrels exist because index.js is a heavy barrel inside a
 * large import SCC: consumers that canonical-loop itself transitively
 * imports (tool-execution, chat-ws, tools registered in the tool-registry,
 * ollama-cloud, ops/) would mint import cycles if pointed at index.js, so
 * they use the light pass-through barrels in public/ instead.
 *
 * The repo has no ESLint toolchain, so this vitest test IS the enforcement:
 * it regex-scans every .ts file under src/ (excluding src/canonical-loop/
 * itself) for static and dynamic import specifiers that reach past the
 * public surface.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Every import/export/require specifier in a TS source, static or dynamic. */
const SPECIFIER_RE =
	/(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`]+)["'`]/g;

/** A canonical-loop specifier that reaches past the public surface. */
function isDeepCanonicalLoopPath(spec: string): boolean {
	const m = spec.match(/^(?:\.{1,2}\/)*(?:.*\/)?canonical-loop(\/.*)?$/);
	if (!m || !spec.includes("canonical-loop")) return false;
	const sub = m[1] ?? "";
	if (sub === "" || sub === "/" || sub === "/index.js") return false; // front door
	if (/^\/public\/[^/]+\.js$/.test(sub)) return false; // public sub-barrel
	return true;
}

function* walkTsFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			if (resolve(full) === resolve(SRC_DIR, "canonical-loop")) continue;
			yield* walkTsFiles(full);
		} else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
			yield full;
		}
	}
}

describe("canonical-loop interface seal", () => {
	it("no file under src/ deep-imports canonical-loop internals", () => {
		const violations: string[] = [];
		for (const file of walkTsFiles(SRC_DIR)) {
			// Normalize backslash-escaped slashes ("canonical-loop\/types") so an
			// escaped specifier can't slip past the prefilter or the regex.
			const text = readFileSync(file, "utf8").replace(/\\\//g, "/");
			if (!text.includes("canonical-loop/")) continue;
			for (const match of text.matchAll(SPECIFIER_RE)) {
				if (isDeepCanonicalLoopPath(match[1])) {
					const line = text.slice(0, match.index).split("\n").length;
					violations.push(`${relative(SRC_DIR, file)}:${line} → "${match[1]}"`);
				}
			}
		}
		expect(
			violations,
			`deep imports into src/canonical-loop internals are banned; ` +
				`import from canonical-loop/index.js or a canonical-loop/public/* sub-barrel ` +
				`(promote the symbol there if it is missing):\n  ${violations.join("\n  ")}`,
		).toEqual([]);
	});

	// The regex must actually catch the patterns it claims to, or the seal is
	// theater. Exercise it against representative offender shapes.
	it("the specifier matcher catches static, dynamic, and type deep imports", () => {
		const bad = [
			"../canonical-loop/types.js",
			"../../canonical-loop/agent-runner.js",
			"../../../canonical-loop/store.js",
			"./canonical-loop/model-capabilities.js",
			"../canonical-loop/instruction-ledger/index.js",
			"../canonical-loop/instruction-ledger/plan-mode.js",
			"../canonical-loop/turn-loop/render-verify.js",
			"../canonical-loop/adapters/app-build-adapter.js",
			"../canonical-loop/public/nested/too-deep.js",
		];
		const good = [
			"../canonical-loop/index.js",
			"../../canonical-loop",
			"./canonical-loop/public/plan-ledger.js",
			"../canonical-loop/public/op-facts.js",
			"../ops/types.js",
			"openai/resources/chat/completions.js",
		];
		for (const s of bad) expect(isDeepCanonicalLoopPath(s), s).toBe(true);
		for (const s of good) expect(isDeepCanonicalLoopPath(s), s).toBe(false);
	});
});
