/**
 * The language table the structure scripts share. One row per language says
 * which files are source, which are tests, how an import is written and how
 * it resolves to a file, where the source roots are by default, what a module
 * is, and which folders its builds write. codebase-map.mjs,
 * check-module-owners.mjs, check-doc-paths.mjs and check-structure.mjs import
 * this file, so a project copies it beside them; nothing else reads it.
 * Supporting a language is adding a row here, not a special case there.
 *
 * What a module is, per language:
 *   JS/TS, Python  a top-level directory under a source root (`src/auth/`);
 *                  a file directly under the root is a loose root file.
 *   Rust           a top-level directory OR a top-level .rs file under src/
 *                  (`src/auth/` and `src/auth.rs` are one module, `auth`);
 *                  main.rs and lib.rs are the crate root, not modules.
 *   Go             a package directory, at any depth (`internal/auth/token/`).
 *
 * Default source roots, from the project file at the repo root:
 *   Cargo.toml → src · go.mod → internal/, cmd/, pkg/ (those present) ·
 *   package.json → src, or the framework's layout when there is no src/
 *   (SvelteKit's src/lib, an app/ dir for Next app-router and React Router,
 *   formerly Remix) ·
 *   pyproject.toml / nothing → src.
 *
 * Import resolution (only imports inside the mapped tree count):
 *   JS/TS   relative specifiers; .js→.ts remapping; index files
 *   Python  relative imports; root-anchored absolute imports
 *   Rust    `mod x;` → x.rs | x/mod.rs beside the declaring file (or under its
 *           own directory for a non-root file); `crate::a::b` → src/a/b.rs |
 *           src/a/b/mod.rs | src/a.rs | src/a/mod.rs, longest match first
 *   Go      an import path under go.mod's module path → that directory's
 *           non-test .go files
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// vendor/ and third_party/ hold code we ship but don't own — not mapped, not checked.
export const SKIP_DIRS = new Set([
	"node_modules", "dist", "build", ".git", "__pycache__", ".venv", "venv", "coverage", ".next",
	"vendor", "third_party", "target",
]);

const posix = (p) => p.split(sep).join("/");
// Exact-case: on a case-insensitive filesystem `store/Db.rs` would otherwise
// "exist" for `store/db.rs`, and the edge would point at a file not in the tree.
const isFile = (p) => existsSync(p) && statSync(p).isFile() && readdirSync(dirname(p)).includes(basename(p));
const firstFile = (candidates) => candidates.find(isFile) ?? null;

const JS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_SPEC = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`]+)["'`]/g;
const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const RS_MOD = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm;
const RS_CRATE_PATH = /\bcrate::(\w+(?:::\w+)*)/g;
const GO_IMPORT_BLOCK = /^\s*import\s*\(([\s\S]*?)\)/gm;
const GO_IMPORT_ONE = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
const GO_QUOTED = /"([^"]+)"/g;

/** A directory module: the top-level directory under the root; a file directly
 *  under the root is loose (null). */
function topLevelDirModule(root, parts, repo) {
	if (parts.length < 2) return null;
	const dir = join(root, parts[0]);
	const key = posix(relative(repo, dir));
	return { key, display: `${key}/`, dir };
}

function resolveJs(fromFile, spec) {
	if (!spec.startsWith(".")) return [];
	const base = resolve(dirname(fromFile), spec);
	const stem = base.replace(/\.(m|c)?jsx?$/, "");
	const hit = firstFile([base, ...JS_EXT.map((e) => stem + e), ...JS_EXT.map((e) => join(base, "index" + e))]);
	return hit ? [hit] : [];
}

function resolvePyModule(dotted, anchorDirs) {
	const rel = dotted.split(".").join(sep);
	for (const anchor of anchorDirs) {
		const hit = firstFile([join(anchor, rel + ".py"), join(anchor, rel, "__init__.py")]);
		if (hit) return hit;
	}
	return null;
}

function pyTargets(fromFile, text, ctx) {
	const out = [];
	const anchors = ctx.roots.flatMap((r) => [r, dirname(r)]);
	for (const m of text.matchAll(PY_FROM)) {
		const [, mod, names] = m;
		const dots = mod.match(/^\.*/)[0].length;
		let anchorDirs = anchors;
		const dotted = mod.slice(dots);
		if (dots > 0) {
			let d = dirname(fromFile);
			for (let i = 1; i < dots; i++) d = dirname(d);
			anchorDirs = [d];
		}
		const pkg = dotted ? resolvePyModule(dotted, anchorDirs) : null;
		if (pkg) out.push(pkg);
		// `from pkg import submodule` targets the submodule file when one exists.
		for (const n of names.replace(/[()]/g, "").split(",")) {
			const name = n.trim().split(/\s+/)[0];
			if (!/^\w+$/.test(name)) continue;
			const sub = resolvePyModule(dotted ? `${dotted}.${name}` : name, anchorDirs);
			if (sub) out.push(sub);
		}
	}
	for (const m of text.matchAll(PY_IMPORT)) {
		for (const dotted of m[1].split(",")) {
			const hit = resolvePyModule(dotted.trim(), anchors);
			if (hit) out.push(hit);
		}
	}
	return out;
}

/** The directory a file's `mod x;` children live in: beside main.rs / lib.rs /
 *  mod.rs, under its own name for any other file (`auth.rs` → `auth/`). */
function rustChildDir(file) {
	const name = basename(file, ".rs");
	return ["main", "lib", "mod"].includes(name) ? dirname(file) : join(dirname(file), name);
}

function rustTargets(file, text, ctx) {
	const out = [];
	const childDir = rustChildDir(file);
	for (const m of text.matchAll(RS_MOD)) {
		const hit = firstFile([join(childDir, m[1] + ".rs"), join(childDir, m[1], "mod.rs")]);
		if (hit) out.push(hit);
	}
	const crateRoot = ctx.roots.find((r) => file.startsWith(r + sep));
	if (!crateRoot) return out;
	for (const m of text.matchAll(RS_CRATE_PATH)) {
		const segs = m[1].split("::");
		for (let n = segs.length; n >= 1; n--) {
			const stem = join(crateRoot, ...segs.slice(0, n));
			const hit = firstFile([stem + ".rs", join(stem, "mod.rs")]);
			if (hit) { out.push(hit); break; }
		}
	}
	return out;
}

function goTargets(file, text, ctx) {
	if (!ctx.goModule) return [];
	const paths = [];
	for (const m of text.matchAll(GO_IMPORT_BLOCK)) for (const q of m[1].matchAll(GO_QUOTED)) paths.push(q[1]);
	for (const m of text.matchAll(GO_IMPORT_ONE)) paths.push(m[1]);
	const out = [];
	for (const p of paths) {
		if (p !== ctx.goModule && !p.startsWith(ctx.goModule + "/")) continue;
		const dir = join(ctx.repo, ...p.slice(ctx.goModule.length).split("/").filter(Boolean));
		if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
		for (const name of readdirSync(dir)) {
			if (name.endsWith(".go") && !name.endsWith("_test.go")) out.push(join(dir, name));
		}
	}
	return out;
}

export const LANGUAGES = [
	{
		id: "js",
		extensions: JS_EXT,
		isSource: (name) => !name.endsWith(".d.ts"),
		isTest: (base) => /\.(test|spec)\.[^.]+$/.test(base),
		projectFiles: ["package.json"],
		// The framework's own layout when it is not src/: SvelteKit keeps modules in
		// src/lib (routes are files, not modules); Next's app-dir and React Router
		// (formerly Remix) use app/.
		roots: (repo) => {
			if (existsSync(join(repo, "src", "lib")) && readdirSync(repo).some((n) => /^svelte\.config\.(js|mjs|ts)$/.test(n))) return ["src/lib"];
			if (!existsSync(join(repo, "src")) && existsSync(join(repo, "app"))) return ["app"];
			return ["src"];
		},
		// Vite and Astro build to dist/, React Router to build/, Next to .next/ (out/
		// when exported), Nuxt to .nuxt/ and .output/; the rest are generated types.
		buildOutputs: ["dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit", ".astro", ".react-router"],
		moduleOf: topLevelDirModule,
		imports: (file, text) => [...text.replace(/\\\//g, "/").matchAll(JS_SPEC)].flatMap((m) => resolveJs(file, m[1])),
	},
	{
		id: "python",
		extensions: [".py"],
		isSource: () => true,
		isTest: (base) => /^test_.*\.py$/.test(base) || /_test\.py$/.test(base),
		projectFiles: ["pyproject.toml", "setup.py", "requirements.txt"],
		roots: () => ["src"],
		buildOutputs: ["dist", "build"],
		moduleOf: topLevelDirModule,
		imports: pyTargets,
	},
	{
		id: "rust",
		extensions: [".rs"],
		isSource: () => true,
		isTest: () => false,
		projectFiles: ["Cargo.toml"],
		roots: () => ["src"],
		buildOutputs: ["target"],
		moduleOf: (root, parts, repo) => {
			if (parts.length > 1) return topLevelDirModule(root, parts, repo);
			const name = basename(parts[0], ".rs");
			if (name === "main" || name === "lib") return null;
			const dir = join(root, name);
			const key = posix(relative(repo, dir));
			return existsSync(dir)
				? { key, display: `${key}/`, dir }
				: { key, display: `${key}.rs`, dir: null };
		},
		imports: rustTargets,
	},
	{
		id: "go",
		extensions: [".go"],
		isSource: () => true,
		isTest: (base) => /_test\.go$/.test(base),
		projectFiles: ["go.mod"],
		roots: (repo) => ["internal", "cmd", "pkg"].filter((d) => existsSync(join(repo, d))),
		buildOutputs: [], // `go build` writes beside the source or into GOBIN, no output folder
		moduleOf: (root, parts, repo) => {
			const dir = join(root, ...parts.slice(0, -1));
			const key = posix(relative(repo, dir));
			return { key, display: `${key}/`, dir };
		},
		imports: goTargets,
	},
];

/** Every language's build-output folder names: a doc that names one points at
 *  something a build makes, not a missing path. */
export const BUILD_OUTPUT_DIRS = new Set(LANGUAGES.flatMap((l) => l.buildOutputs));

export const languageOf = (file) => LANGUAGES.find((l) => l.extensions.some((e) => file.endsWith(e))) ?? null;

export const isSourceFile = (name) => languageOf(name)?.isSource(name) ?? false;

/** A test by its language's naming rule, or anything under a test directory. */
export function isTestPath(relPosix) {
	const base = relPosix.split("/").pop();
	if (/(^|\/)(__tests__|tests?)\//.test(relPosix)) return true;
	return languageOf(base)?.isTest(base) ?? false;
}

/** The project kind's default source roots (repo-relative), from the project
 *  file at the repo root; `src` when nothing identifies the kind. */
export function defaultRoots(repo) {
	for (const lang of [...LANGUAGES].reverse()) {
		if (lang.projectFiles.some((f) => existsSync(join(repo, f)))) return lang.roots(repo);
	}
	return ["src"];
}

/** Every source file under `dir`, skipping vendored and generated trees. */
export function walkSource(dir) {
	const out = [];
	for (const name of readdirSync(dir).sort()) {
		if (SKIP_DIRS.has(name)) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walkSource(p));
		else if (isSourceFile(name)) out.push(p);
	}
	return out;
}

/** The module a file belongs to: `{ key, display, dir }`, repo-relative posix
 *  key and the path a doc names (`src/auth/`, `src/auth.rs`); null for a loose
 *  file directly under the root. `dir` is the module directory when it has one. */
export function moduleOf(file, root, repo) {
	const lang = languageOf(file);
	const parts = posix(relative(root, file)).split("/");
	return lang ? lang.moduleOf(root, parts, repo) : null;
}

/** State the import resolvers need: the repo, the absolute roots, go.mod's module path. */
export function importContext(repo, roots) {
	const goMod = join(repo, "go.mod");
	const goModule = existsSync(goMod) ? readFileSync(goMod, "utf8").match(/^module\s+(\S+)/m)?.[1] ?? null : null;
	return { repo, roots, goModule };
}

/** Absolute paths of the files `file` imports, by its language's rules. */
export function importTargets(file, ctx) {
	const lang = languageOf(file);
	return lang ? lang.imports(file, readFileSync(file, "utf8"), ctx) : [];
}
