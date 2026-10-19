/**
 * The TypeScript compiler API the structure scripts parse JS/TS with, found
 * once per process. A `typescript` package qualifies only when it exposes that
 * API (createSourceFile, forEachChild, ScriptTarget, SyntaxKind). TypeScript 7's
 * package — the native compiler — exports only its version from its main entry,
 * and every project a current Vite template creates pins it, so loading
 * whatever `typescript` resolves and calling into it crashed the size check.
 *
 * Where it looks, first match wins:
 *   1. STRUCTURE_TYPESCRIPT — a directory holding a `typescript` package with the
 *      API. A host that runs a project's check (an agent harness) hands over its
 *      own copy this way; the entry scripts set it from `--typescript <dir>`, and
 *      the scripts they spawn inherit it.
 *   2. the project's own `typescript`.
 *   3. a `typescript` reachable from these scripts' own location.
 * Each candidate that did not qualify is kept with why, so a check that falls
 * back can say what it found instead.
 */
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export const TYPESCRIPT_ENV = "STRUCTURE_TYPESCRIPT";

/** `--typescript <dir>` on an entry script's argv, exported for the scripts it spawns. */
export function applyTypeScriptFlag(args) {
	const i = args.indexOf("--typescript");
	if (i >= 0 && args[i + 1]) process.env[TYPESCRIPT_ENV] = resolve(args[i + 1]);
}

export function hasCompilerApi(ts) {
	return !!ts && typeof ts.createSourceFile === "function" && typeof ts.forEachChild === "function"
		&& typeof ts.ScriptTarget === "object" && typeof ts.SyntaxKind === "object";
}

const found = new Map(); // repo -> { ts, rejected }

/** `{ ts, rejected }`: the first qualifying module (or null) and why each other candidate did not qualify. */
export function loadTypeScript(repo) {
	if (found.has(repo)) return found.get(repo);
	const override = process.env[TYPESCRIPT_ENV];
	const candidates = [
		...(override ? [[`${TYPESCRIPT_ENV}=${override}`, () => createRequire(join(resolve(override), "package.json"))(resolve(override))]] : []),
		["the project's typescript", () => createRequire(join(repo, "package.json"))("typescript")],
		["typescript beside the structure scripts", () => createRequire(import.meta.url)("typescript")],
	];
	const rejected = [];
	let ts = null;
	for (const [label, load] of candidates) {
		let mod;
		try { mod = load(); } catch { rejected.push(`${label}: not installed`); continue; }
		if (hasCompilerApi(mod)) { ts = mod; break; }
		rejected.push(`${label}: version ${mod?.version ?? "unknown"} has no compiler API`);
	}
	const result = { ts, rejected };
	found.set(repo, result);
	return result;
}

/** One line saying why JS/TS was measured without the compiler, and how to fix it. */
export function missingCompilerNote(rejected) {
	return `no TypeScript with the compiler API was found (${rejected.join("; ")}). ` +
		"TypeScript 7's package has none; install TypeScript 5 or 6 beside it, or pass --typescript <dir of one>.";
}
