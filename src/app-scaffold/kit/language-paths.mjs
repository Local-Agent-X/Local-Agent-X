/**
 * The file-system helpers the language rows share: exact-case file checks,
 * the first existing candidate, a directory's source files, and the
 * "top-level directory under the root" module rule most languages use.
 * project-languages.mjs and project-languages-toolchains.mjs import this file,
 * so a project copies it beside them; nothing else reads it.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

export const posix = (p) => p.split(sep).join("/");

// Exact-case: on a case-insensitive filesystem `store/Db.rs` would otherwise
// "exist" for `store/db.rs`, and the edge would point at a file not in the tree.
export const isFile = (p) => existsSync(p) && statSync(p).isFile() && readdirSync(dirname(p)).includes(basename(p));
export const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
export const firstFile = (candidates) => candidates.find(isFile) ?? null;

/** The files directly in `dir` whose names end in one of `extensions`
 *  (every level below too when `deep`), skipping the folders in `skip`. */
export function filesIn(dir, extensions, { deep = false, skip = new Set() } = {}) {
	if (!isDir(dir)) return [];
	const out = [];
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			if (deep && !skip.has(name)) out.push(...filesIn(p, extensions, { deep, skip }));
		} else if (extensions.some((e) => name.endsWith(e))) out.push(p);
	}
	return out;
}

/** A directory module: the top-level directory under the root; a file directly
 *  under the root is loose (null). */
export function topLevelDirModule(root, parts, repo) {
	if (parts.length < 2) return null;
	const dir = join(root, parts[0]);
	const key = posix(relative(repo, dir));
	return { key, display: `${key}/`, dir };
}
